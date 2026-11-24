import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { guardStatusSchema } from "../shared";

/** The guard on this Mac, always with --dry-run: it logs what it would do and never does it. */
describe.runIf(process.platform === "darwin")("guard.mjs", () => {
  const script = fileURLToPath(new URL("./guard.mjs", import.meta.url));
  const bb = "/Applications/bb.app/Contents/MacOS/bb",
    node = existsSync(bb) ? bb : process.execPath;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const root = mkdtempSync(join(os.tmpdir(), "guard-test-")),
    pids: number[] = [];
  afterAll(async () => {
    for (const pid of pids) process.kill(-pid, "SIGKILL");
    await rm(root, { recursive: true });
  });

  /** Its directory; BB is an app that runs nothing unless a test says otherwise. */
  async function home(files: Record<string, unknown>) {
    const dir = await mkdtemp(join(root, "home-"));
    const all = Object.entries({
      "config.json": { bbAppPath: "/nonexistent/X.app" },
      ...files,
    });
    await Promise.all(
      all.map(([name, v]) =>
        writeFile(
          join(dir, name),
          typeof v === "string" ? v : JSON.stringify(v),
        ),
      ),
    );
    return dir;
  }

  /** Runs the guard until it exits, or SIGTERMs it after `ms`. */
  async function guard(dir: string, ms = 20_000) {
    const child = spawn(node, [script, "--home", dir, "--dry-run"], { env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), ms);
    const [code] = await once(child, "exit");
    clearTimeout(timer);
    return { code, out };
  }

  /** A stand-in BB: run from an app bundle, with one child it started. */
  async function fakeBb() {
    const app = join(await home({}), "X.app");
    await mkdir(app);
    await symlink(process.execPath, join(app, "bb"));
    const code =
      "require('node:child_process').spawn('/bin/sleep', ['60']); setInterval(() => {}, 1e3)";
    const { pid } = spawn(join(app, "bb"), ["-e", code], {
      detached: true,
      stdio: "ignore",
    });
    if (pid) pids.push(pid); // Its own process group: killed with its sleep.
    return app;
  }

  it("writes a status in the shared schema and exits 143 on SIGTERM", async () => {
    const dir = await home({});
    const { code } = await guard(dir, 3000);
    expect(code).toBe(143);
    guardStatusSchema.parse(
      JSON.parse(await readFile(join(dir, "status.json"), "utf8")),
    );
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  it("lets go of what it held on the same processes only, and exits 0 when turned off", async () => {
    const { pid } = spawn("/bin/sleep", ["60"], { detached: true });
    if (pid) pids.push(pid);
    const hold = {
      startedAt: Date.now(),
      args: "/bin/sleep 60",
      stopped: true,
      bg: true,
    };
    const held = [
      [pid, hold],
      [process.pid, { ...hold, args: "/bin/fake" }],
    ];
    const config = { enabled: false, bbAppPath: "/nonexistent/X.app" };
    const { code, out } = await guard(
      await home({ "config.json": config, "state.json": { held } }),
    );
    expect([code, out.match(/dry-run \w+ \d+/gu)]).toEqual([
      0,
      [`dry-run cont ${pid}`, `dry-run unbg ${pid}`],
    ]);
  });

  it("uninstalls itself when the heartbeat is two days old", async () => {
    const dir = await home({ heartbeat: String(Date.now() - 2 * 86_400e3) });
    const { code, out } = await guard(dir);
    expect(code).toBe(0);
    expect(out).toMatch(
      /dry-run uninstall: remove .*app\.getbb\.resource-monitor\.guard\.plist/u,
    );
  });

  it("exits 0 without acting when BB is not an app bundle", async () => {
    const dir = await home({ "config.json": { bbAppPath: "/usr/local/bin" } });
    expect(await guard(dir)).toMatchObject({
      code: 0,
      out: expect.stringContaining("not inside an app bundle"),
    });
  });

  it("ignores Pause all once the heartbeat is ten minutes old", async () => {
    const app = await fakeBb();
    const paused = (beat: number) =>
      home({
        "config.json": { bbAppPath: app },
        "control.json": { pauseAll: true },
        heartbeat: String(beat),
      });
    const [fresh, stale] = await Promise.all(
      [paused(Date.now()), paused(Date.now() - 3600e3)].map(async (dir) =>
        guard(await dir, 5000),
      ),
    );
    expect(fresh.out).toMatch(/dry-run stop \d+ sleep 60/u);
    expect(stale.out).not.toContain("dry-run stop");
  }, 15_000);
});
