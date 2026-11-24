import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bbAppPath,
  buildPlist,
  createGuard,
  guardSourceDir,
} from "./guard-install";

const EXEC = "/Applications/bb.app/Contents/MacOS/bb";
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;
const TARGET = `${DOMAIN}/app.getbb.resource-monitor.guard`;
const status = (age: number) => ({
  updatedAt: Date.now() - age,
  mode: "normal",
  counts: { background: 0, paused: 0 },
  events: [],
});

const temps: string[] = [];
afterEach(() =>
  Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true }))),
);

/** The plugin's guard files, an empty guard home, and a launchctl that records calls. */
async function setup(fails = "") {
  const root = await mkdtemp(join(tmpdir(), "guard-"));
  temps.push(root);
  const source = join(root, "plugin", "guard");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "guard.mjs"), "// guard\n");
  await writeFile(join(source, "guard.test.ts"), "// not copied\n");
  const home = join(root, "home");
  const plist = join(root, "agent.plist");
  const calls: string[] = [];
  const launchctl = async (...args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === fails) throw new Error(`${fails} failed`);
  };
  const guard = createGuard({ home, plist, source, execPath: EXEC, launchctl });
  const read = async (name: string) =>
    JSON.parse(await readFile(join(home, name), "utf8"));
  const put = (name: string, value: unknown) =>
    writeFile(join(home, name), JSON.stringify(value));
  /** Applies, then gives the launchctl calls of that pass. */
  const apply = async (on: boolean) => (
    calls.splice(0),
    await guard.apply(on),
    calls
  );
  return { root, source, home, plist, calls, guard, read, put, apply };
}

it("runs BB's binary as Node on the guard, restarting it only after a crash", async () => {
  const plist = buildPlist(EXEC, "/x/A & <B>");
  for (const line of [
    "<key>Label</key><string>app.getbb.resource-monitor.guard</string>",
    `<array><string>${EXEC}</string><string>/x/A &amp; &lt;B>/guard.mjs</string></array>`,
    "<dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>",
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>",
    "<key>ProcessType</key><string>Interactive</string>",
    "<key>StandardOutPath</key><string>/x/A &amp; &lt;B>/guard.log</string>",
    "<key>StandardErrorPath</key><string>/x/A &amp; &lt;B>/guard.log</string>",
  ])
    expect(plist).toContain(line);
  if (process.platform !== "darwin") return;
  const { root } = await setup();
  await writeFile(join(root, "t.plist"), plist);
  expect(
    execFileSync("/usr/bin/plutil", ["-lint", join(root, "t.plist")], {
      encoding: "utf8",
    }),
  ).toMatch(/OK$/mu);
});

it("finds BB's app bundle and the plugin's guard/ directory", () => {
  expect(bbAppPath(EXEC)).toBe("/Applications/bb.app");
  expect(
    bbAppPath(
      "/Applications/bb.app/Contents/Frameworks/bb Helper.app/Contents/MacOS/bb Helper",
    ),
  ).toBe("/Applications/bb.app");
  expect(bbAppPath("/opt/homebrew/bin/node")).toBe("/opt/homebrew/bin");
  expect(guardSourceDir("file:///p/rm/dist/server.js")).toBe("/p/rm/guard");
  expect(guardSourceDir("file:///p/rm/guard-install.ts")).toBe("/p/rm/guard");
});

describe("apply", () => {
  it("on a fresh Mac: copies the guard, writes its files and plist, and loads it", async () => {
    const { home, plist, read, apply } = await setup();
    expect(await apply(true)).toEqual([
      `bootout ${TARGET}`,
      `bootstrap ${DOMAIN} ${plist}`,
    ]);
    expect((await readdir(home)).sort()).toEqual([
      "config.json",
      "guard.mjs",
      "heartbeat",
    ]);
    expect(await read("config.json")).toEqual({
      enabled: true,
      bbAppPath: "/Applications/bb.app",
    });
    expect(Date.now() - (await read("heartbeat"))).toBeLessThan(5000);
    expect(await readFile(plist, "utf8")).toBe(buildPlist(EXEC, home));
  });

  it("leaves a current, running guard alone and keeps Pause all", async () => {
    const { put, read, apply } = await setup();
    await apply(true);
    await put("status.json", status(0));
    await put("control.json", { pauseAll: true });
    expect(await apply(true)).toEqual([]);
    expect(await read("control.json")).toEqual({ pauseAll: true });
  });

  it("starts a guard that quit, and loads an agent launchd lost", async () => {
    const quit = await setup();
    await quit.apply(true);
    expect(await quit.apply(true)).toEqual([`kickstart ${TARGET}`]);
    const lost = await setup("kickstart");
    await lost.apply(true);
    expect(await lost.apply(true)).toEqual([
      `kickstart ${TARGET}`,
      `bootstrap ${DOMAIN} ${lost.plist}`,
    ]);
  });

  it("reloads the agent when the guard's files change", async () => {
    const { source, home, put, apply } = await setup();
    await apply(true);
    await put("status.json", status(0));
    await writeFile(join(source, "guard.mjs"), "// guard 2\n");
    expect((await apply(true)).map((call) => call.split(" ")[0])).toEqual([
      "bootout",
      "bootstrap",
    ]);
    expect(await readFile(join(home, "guard.mjs"), "utf8")).toBe(
      "// guard 2\n",
    );
  });

  it("turns off: Pause all off, then the config, then bootout, then the plist", async () => {
    const { home, plist, put, read, apply } = await setup();
    await apply(true);
    await put("control.json", { pauseAll: true });
    const seen: unknown[] = [];
    const off = createGuard({
      home,
      plist,
      launchctl: async (...args) => {
        seen.push(
          args.join(" "),
          (await read("config.json")).enabled,
          existsSync(plist),
        );
      },
    });
    await off.apply(false);
    expect(seen).toEqual([`bootout ${TARGET}`, false, true]);
    expect(await read("control.json")).toEqual({ pauseAll: false });
    expect(existsSync(plist)).toBe(false);
    await off.apply(false);
    expect(seen).toHaveLength(3);
  });
});

it("reads the status, fresh or stale, and drops an invalid one", async () => {
  const { home, guard, put } = await setup();
  expect(await guard.info(true)).toEqual({
    enabled: true,
    running: false,
    pauseAll: false,
    status: null,
  });
  await mkdir(home);
  const fresh = status(1000);
  await put("status.json", fresh);
  expect(await guard.setPauseAll(true, false)).toEqual({
    enabled: false,
    running: true,
    pauseAll: true,
    status: fresh,
  });
  await put("status.json", status(60_000));
  expect(await guard.info(true)).toMatchObject({
    running: false,
    status: { mode: "normal" },
  });
  await put("status.json", { ...fresh, mode: "busy" });
  expect(await guard.info(true)).toMatchObject({
    running: false,
    status: null,
  });
});
