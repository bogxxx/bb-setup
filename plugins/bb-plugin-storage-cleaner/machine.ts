// One machine's Storage Cleaner: its scan, kept on its own disk, and the
// snapshots, folders and cleanups the page asks the server for. The host
// entry runs it on every BB machine; the server only passes BB's threads.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { setPriority } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { cleanBb, cleanDev, cleanTrash, deletePaths } from "./clean";
import type { ThreadRow } from "./contract";
import {
  assignGroups,
  folder,
  kidsAt,
  matchCase,
  paths,
  snapshot,
  type Context,
  type Disk,
  type Scan,
  type ThreadInfo,
} from "./model";
import { pathMap, type PathMap } from "./platform";
import { SCANNER_PY } from "./scanner";
import { SCANNER_JS } from "./scanner-node";
import type { Outcome, Platform, Snapshot } from "./shared";

const run = promisify(execFile);
const SCAN_TIMEOUT = 30 * 60_000;

/** Keeps the host worker alive past the call that asked. */
export type Retain = () => { dispose(): Promise<void> };

export interface Known {
  threads: ThreadRow[];
  inUse: string[];
}

export interface MachineOptions {
  platform: Platform;
  /** The home folder as the OS spells it. */
  home: string;
  /** BB's data folder on this machine, as the OS spells it; null if unknown. */
  bbData: string | null;
  /** Where the scan is kept between runs. */
  dataDir: string;
  /** Scratch space for the scanner. */
  tempDir: string;
  /** The environment the scanner runs with. */
  env: NodeJS.ProcessEnv;
  /** Tells the server the page should read this machine again. */
  emit(reason: string): void;
  log(message: string): void;
}

// macOS: the data volume holds everything but the sealed system; "/" elsewhere.
const MAC_ROOT = existsSync("/System/Volumes/Data/Users")
  ? "/System/Volumes/Data"
  : "/";
const MAC_VOLUMES: Record<string, string> = {
  "/": "macOS system",
  "/System/Volumes/Preboot": "Preboot",
  "/System/Volumes/VM": "VM swap",
  "/System/Volumes/Update": "Update",
  "/Volumes/Recovery": "Recovery",
};

/** macOS sizes from `df`: the container's total and free, and its other volumes. */
async function macDisk(): Promise<Disk> {
  const { stdout } = await run("df", ["-k"]);
  const rows = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.split(/\s+/))
    .filter((cols) => cols[0]?.startsWith("/dev/") && cols.length >= 6)
    .map((cols) => ({
      mount: cols[cols.length - 1],
      size: +cols[1] * 1024,
      used: +cols[2] * 1024,
      free: +cols[3] * 1024,
    }));
  const main =
    rows.find((r) => r.mount === MAC_ROOT) ?? rows.find((r) => r.mount === "/");
  const volumes =
    MAC_ROOT === "/"
      ? []
      : rows
          .filter((r) => MAC_VOLUMES[r.mount] && r.used > 0)
          .map((r) => ({ label: MAC_VOLUMES[r.mount], bytes: r.used }));
  return {
    total: main?.size ?? 0,
    free: main?.free ?? 0,
    used: main?.used ?? 0,
    volumes,
  };
}

/** File systems Linux mounts from local disks, and not as images or boot partitions. */
export function linuxMounts(procMounts: string) {
  const skip = ["/boot", "/snap", "/var/lib/docker", "/var/snap", "/run", "/proc", "/sys", "/dev"];
  const images = new Set(["squashfs", "iso9660", "udf", "overlay"]);
  // /proc/mounts writes a space in a path as \040.
  const unescape = (text: string) =>
    text.replace(/\\([0-7]{3})/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 8)),
    );
  return procMounts
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([device, , type]) => device?.startsWith("/dev/") && !images.has(type))
    .map(([, mount]) => unescape(mount))
    .filter(
      (mount) =>
        mount === "/" ||
        !skip.some((s) => mount === s || mount.startsWith(`${s}/`)),
    );
}

/** Linux: every local disk file system, once each. */
async function linuxDisks() {
  const text = await readFile("/proc/mounts", "utf8").catch(() => "");
  const mounts = ["/", ...linuxMounts(text)];
  const byDev = new Map<number, { total: number; free: number; used: number }>();
  for (const mount of mounts) {
    try {
      const { dev } = await lstat(mount);
      if (byDev.has(dev)) continue;
      const s = await statfs(mount);
      byDev.set(dev, {
        total: s.blocks * s.bsize,
        free: s.bavail * s.bsize,
        used: (s.blocks - s.bfree) * s.bsize,
      });
    } catch {
      // A mount that went away or can't be read isn't scanned.
    }
  }
  return byDev;
}

async function statfsDisk(root: string): Promise<Disk> {
  const s = await statfs(root);
  return {
    total: s.blocks * s.bsize,
    free: s.bavail * s.bsize,
    used: (s.blocks - s.bfree) * s.bsize,
    volumes: [],
  };
}

/** Whether BB has Full Disk Access: only then may it read the TCC database. */
function macFullDiskAccess(): Promise<boolean> {
  return open("/Library/Application Support/com.apple.TCC/TCC.db").then(
    (file) => file.close().then(() => true),
    () => false,
  );
}

/** Run a scanner process and wait for it; it may run for half an hour. */
function runScanner(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  lowerPriority: boolean,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env,
      windowsHide: true,
    });
    if (lowerPriority && child.pid)
      try {
        setPriority(child.pid, 10);
      } catch {
        // Normal priority, then.
      }
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    // A worker that dies can leave a scanner waiting forever; stop it.
    const timer = setTimeout(() => child.kill(), SCAN_TIMEOUT);
    child.on("error", reject);
    child.on("exit", () => clearTimeout(timer));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              stderr.trim().split("\n").pop() || `scanner exited with ${code}`,
            ),
          ),
    );
  });
}

/** The drive letter of a Windows path, "C:". */
export const driveOf = (path: string) =>
  /^[A-Za-z]:/.test(path) ? `${path[0].toUpperCase()}:` : "C:";

/**
 * BB's data folder on this machine: a plugin's host data lives in
 * <data>/plugins/<plugin>/host-data.
 */
export function bbDataOf(pluginDataDir: string) {
  const parts = pluginDataDir.split(/[\\/]/);
  const at = parts.lastIndexOf("plugins");
  return at > 0 ? parts.slice(0, at).join(pluginDataDir.includes("\\") ? "\\" : "/") : null;
}

export function createMachine(options: MachineOptions) {
  const { platform } = options;
  const map: PathMap = pathMap(
    platform,
    platform === "win32" ? driveOf(options.home) : null,
  );
  const scanFile = join(options.dataDir, "scan.json.gz");
  let scan: Scan | null | undefined;
  let scanning: Promise<boolean> | null = null;
  let error: string | null = null;

  const load = async () => {
    if (scan === undefined) {
      const data = await readFile(scanFile).catch(() => null);
      try {
        scan = data
          ? (JSON.parse(gunzipSync(data).toString("utf8")) as Scan)
          : null;
      } catch {
        scan = null;
      }
    }
    return scan;
  };
  const save = async () => {
    if (!scan) return;
    await mkdir(options.dataDir, { recursive: true });
    const temp = `${scanFile}.${process.pid}.tmp`;
    await writeFile(temp, gzipSync(JSON.stringify(scan)));
    await rename(temp, scanFile);
  };

  const fullDiskAccess = () =>
    platform === "darwin" ? macFullDiskAccess() : Promise.resolve(true);

  const root = platform === "win32" ? `${map.drive}\\` : "/";

  async function disk(): Promise<Disk> {
    if (platform === "darwin") return macDisk();
    if (platform === "win32") return statfsDisk(root);
    const disks = [...(await linuxDisks()).values()];
    const sum = (key: "total" | "free" | "used") =>
      disks.reduce((t, d) => t + d[key], 0);
    return { total: sum("total"), free: sum("free"), used: sum("used"), volumes: [] };
  }

  /** Run the platform's scanner at low priority and read its result. */
  async function scanDisk(): Promise<Scan> {
    const access = await fullDiskAccess();
    await mkdir(options.tempDir, { recursive: true });
    const dir = await mkdtemp(join(options.tempDir, "scan-"));
    try {
      const out = join(dir, "scan.json");
      if (platform === "darwin") {
        const script = join(dir, "scan.py");
        await writeFile(script, SCANNER_PY);
        await runScanner(
          "nice",
          ["-n", "10", "python3", script, MAC_ROOT, out],
          options.env,
          false,
        );
      } else {
        const script = join(dir, "scan.mjs");
        await writeFile(script, SCANNER_JS);
        const devs =
          platform === "linux"
            ? [...(await linuxDisks()).keys()]
            : [(await lstat(root)).dev];
        await runScanner(
          process.execPath,
          [script, root, out, JSON.stringify({ devs, windows: platform === "win32" })],
          { ...options.env, ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: "16" },
          true,
        );
      }
      const result = JSON.parse(await readFile(out, "utf8")) as Scan;
      result.used = (await disk()).used;
      result.fullDiskAccess = access;
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Scans and cleanups take turns, so none works on a tree another is changing.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Scan the disk; false when it failed. A scan already running is joined.
   * `retain` keeps the host worker alive while the scan outlasts its call.
   */
  function rescan(retain: Retain): Promise<boolean> {
    if (scanning) return scanning;
    const lease = retain();
    error = null;
    options.emit("scan-started");
    scanning = serial(scanDisk)
      .then(async (next) => {
        scan = next;
        await save();
        return true;
      })
      .catch((cause: unknown) => {
        error = cause instanceof Error ? cause.message : String(cause);
        options.log(`scan failed: ${error}`);
        return false;
      })
      .finally(() => {
        scanning = null;
        options.emit("scan-finished");
        void lease.dispose();
      });
    return scanning;
  }

  const home = () => map.toScan(options.home) ?? "/";

  /** The model's context: this machine's paths and disk, BB's threads. */
  async function context(known: Known, gone?: string[]): Promise<Context> {
    const current = await load();
    const cache = new Map<string, string>();
    const fixCase =
      platform === "win32" && current
        ? (path: string) => {
            let fixed = cache.get(path);
            if (fixed === undefined) {
              fixed = matchCase(current.tree, path);
              cache.set(path, fixed);
            }
            return fixed;
          }
        : undefined;
    const fix = fixCase ?? ((path: string) => path);
    const h = fix(home());
    const bbData = options.bbData ? map.toScan(options.bbData) : null;
    const threads = new Map<string, ThreadInfo>(
      known.threads.map(([id, title, project, archivedAt]) => [
        id,
        { title, project, archivedAt },
      ]),
    );
    const goneSet = gone ? new Set(gone) : null;
    const ctx: Context = {
      platform,
      drive: map.drive,
      pathMap: map,
      fixCase,
      home: h,
      bbData: fix(bbData ?? `${h}/.bb`),
      threads,
      inUse: known.inUse.flatMap((p) => {
        const at = map.toScan(p);
        return at ? [fix(at)] : [];
      }),
      // Only a thread BB reported not found counts as gone.
      exists: (threadId) => Promise.resolve(!goneSet?.has(threadId)),
      disk: await disk(),
      now: Math.floor(Date.now() / 1000),
    };
    if (current) assignGroups(current, ctx);
    return ctx;
  }

  /** Run a cleanup on the current scan, then save and tell the page. */
  async function cleanup(
    known: Known,
    gone: string[] | undefined,
    action: (scan: Scan, ctx: Context) => Promise<Outcome>,
  ): Promise<Outcome> {
    if (scanning) throw new Error("A scan is running. Try again in a minute.");
    return serial(async () => {
      const ctx = await context(known, gone);
      const current = await load();
      if (!current) return { freed: 0, failed: [] };
      const outcome = await action(current, ctx);
      await save();
      options.emit("cleaned");
      return outcome;
    });
  }

  return {
    probe() {
      return {
        platform,
        home: options.home,
        bbData: options.bbData,
        drive: map.drive,
      };
    },
    async snapshot(known: Known, retain: Retain): Promise<Snapshot> {
      const access = await fullDiskAccess();
      const current = await load();
      // Once BB has Full Disk Access, scan what it couldn't read before. After
      // a failed scan, wait for Rescan, so a failing scan doesn't repeat.
      if (access && current && !current.fullDiskAccess && !error && !scanning)
        void rescan(retain);
      return snapshot(current, await context(known), {
        scanning: scanning !== null,
        error,
        fullDiskAccess: access,
      });
    },
    async folder(known: Known, path: string) {
      const ctx = await context(known);
      const current = await load();
      const node = current && folder(current, path, ctx);
      return node ? { path, node } : null;
    },
    async rescan(wait: boolean, retain: Retain) {
      const done = rescan(retain);
      if (!wait) return { ok: true, error: null };
      const ok = await done;
      return { ok, error: ok ? null : error };
    },
    async openFullDiskAccess() {
      if (platform === "darwin")
        await run("open", [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        ]);
      return null;
    },
    delete(known: Known, list: string[]) {
      return cleanup(known, undefined, (current, ctx) =>
        deletePaths(list, current, ctx),
      );
    },
    async bbThreadIds() {
      const current = await load();
      if (!current) return { ids: [] };
      const ctx = await context({ threads: [], inUse: [] });
      const p = paths(ctx);
      const ids = new Set<string>();
      for (const dir of [p.threadStorage, p.worktrees])
        for (const child of kidsAt(current.tree, dir)) {
          const id = child.n.replace(/-\d+$/, "");
          if (id.startsWith("thr_")) ids.add(id);
        }
      return { ids: [...ids] };
    },
    clean(
      known: Known,
      input: {
        target: "bb" | "dev" | "trash";
        gone: string[];
        bbThreads: boolean;
        bbWorktrees: boolean;
        staleDays: number | null;
      },
    ) {
      const staleDays = input.staleDays ?? undefined;
      return cleanup(known, input.gone, (current, ctx) =>
        input.target === "bb"
          ? cleanBb(current, ctx, {
              threads: input.bbThreads,
              worktrees: input.bbWorktrees,
              staleDays,
            })
          : input.target === "dev"
            ? cleanDev(current, ctx, staleDays)
            : cleanTrash(current, ctx),
      );
    },
  };
}

export type MachineApi = ReturnType<typeof createMachine>;
