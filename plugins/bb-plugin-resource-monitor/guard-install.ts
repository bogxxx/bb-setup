import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardStatusSchema, type GuardInfo } from "./shared";
import { run } from "./stats";

const LABEL = "app.getbb.resource-monitor.guard";
/** A status file older than this means the guard is not running. */
const GUARD_STALE_MS = 15_000;

/** The plugin's guard/ directory: beside this file, or beside dist/ once bundled. */
export function guardSourceDir(moduleUrl: string): string {
  const dir = dirname(fileURLToPath(moduleUrl));
  return join(basename(dir) === "dist" ? dirname(dir) : dir, "guard");
}

/** The outermost `.app` bundle holding BB's binary, or its directory without one. */
export function bbAppPath(execPath: string): string {
  const parts = execPath.split("/");
  const app = parts.findIndex((part, i) => i > 0 && part.endsWith(".app"));
  return app > 0 ? parts.slice(0, app + 1).join("/") : dirname(execPath);
}

const xml = (text: string) =>
  `<string>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`;

/** BB's binary runs the guard as Node, at login and after a crash; exit 0 keeps it down. */
export function buildPlist(execPath: string, home: string): string {
  const log = xml(join(home, "guard.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${xml(LABEL)}
  <key>ProgramArguments</key>
  <array>${xml(execPath)}${xml(join(home, "guard.mjs"))}</array>
  <key>EnvironmentVariables</key>
  <dict><key>ELECTRON_RUN_AS_NODE</key>${xml("1")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key>${xml("Interactive")}
  <key>StandardOutPath</key>${log}
  <key>StandardErrorPath</key>${log}
</dict>
</plist>
`;
}

/** Writes atomically, so the guard never reads half a file; false when unchanged. */
async function write(path: string, data: string): Promise<boolean> {
  if ((await fs.readFile(path, "utf8").catch(() => null)) === data)
    return false;
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, path);
  return true;
}

const readJson = (path: string) =>
  fs
    .readFile(path, "utf8")
    .then(JSON.parse)
    .catch(() => null);
const ok = (done: Promise<unknown>) =>
  done.then(
    () => true,
    () => false,
  );

const library = join(os.homedir(), "Library");
const defaults = {
  // Outside the plugin, whose directory each update replaces.
  home: join(library, "Application Support/bb-resource-monitor/guard"),
  plist: join(library, "LaunchAgents", `${LABEL}.plist`),
  source: guardSourceDir(import.meta.url),
  execPath: process.execPath,
  launchctl: (...args: string[]): Promise<unknown> =>
    run("/bin/launchctl", args, 10_000),
};

/** Installs, updates, and turns off the guard's LaunchAgent, and reads its status. */
export function createGuard(o: Partial<typeof defaults> = {}) {
  const { home, plist, source, execPath, launchctl } = { ...defaults, ...o };
  const at = (name: string) => join(home, name);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const target = `${domain}/${LABEL}`;
  const bbApp = bbAppPath(execPath);
  const writeJson = (name: string, value: object) =>
    write(at(name), JSON.stringify(value));
  const writeConfig = (enabled: boolean) =>
    writeJson("config.json", { enabled, bbAppPath: bbApp });
  const writeControl = (pauseAll: boolean) =>
    writeJson("control.json", { pauseAll });

  async function info(enabled: boolean): Promise<GuardInfo> {
    const status =
      guardStatusSchema.safeParse(await readJson(at("status.json"))).data ??
      null;
    const pauseAll = (await readJson(at("control.json")))?.pauseAll === true;
    const running = !!status && Date.now() - status.updatedAt < GUARD_STALE_MS;
    return { enabled, running, pauseAll, status };
  }

  /** Brings the agent in line with the setting; cheap when it already is. */
  async function apply(on: boolean): Promise<void> {
    if (!on) {
      if (!existsSync(plist)) return;
      await writeControl(false); // Turning Guard on again must not stop everything.
      await writeConfig(false); // If bootout fails, the guard exits 0 and stays down.
      await ok(launchctl("bootout", target)); // SIGTERM: the guard undoes what it holds.
      await fs.rm(plist, { force: true });
      return;
    }
    // Without a fresh heartbeat the guard takes the plugin as gone.
    await write(at("heartbeat"), String(Date.now()));
    let changed = await write(plist, buildPlist(execPath, home));
    for (const name of (await fs.readdir(source)).filter((n) =>
      n.endsWith(".mjs"),
    ))
      changed =
        (await write(
          at(name),
          await fs.readFile(join(source, name), "utf8"),
        )) || changed;
    await writeConfig(true);
    if (!changed && (await info(true)).running) return;
    if (changed) await ok(launchctl("bootout", target));
    // kickstart starts a loaded guard that quit; it fails when launchd has no such agent.
    else if (await ok(launchctl("kickstart", target))) return;
    await launchctl("bootstrap", domain, plist);
  }

  return {
    /** macOS, with BB's binary in an app bundle that tells BB's processes apart. */
    supported: process.platform === "darwin" && bbApp.endsWith(".app"),
    info,
    apply,
    async setPauseAll(paused: boolean, enabled: boolean) {
      await writeControl(paused);
      return info(enabled);
    },
  };
}
