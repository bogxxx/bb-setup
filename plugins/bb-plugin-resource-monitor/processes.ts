import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProcessInfo } from "./contract";
import { run } from "./stats";

/** One process as read from the system, with its CPU time so far. */
export type Proc = {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  cpuSeconds: number;
  memoryBytes: number;
};
type Reading = { at: number; procs: Proc[] };

/** Command lines are cut to this many characters to keep the list small. */
const COMMAND_CHARS = 200;
/**
 * A list younger than this is served again: several windows poll at once. On
 * Windows each reading starts PowerShell, which costs a good part of a core,
 * so a list lasts longer there.
 */
const FRESH_MS = process.platform === "win32" ? 5000 : 1000;
/** CPU is measured over at least this long. */
const MIN_SPAN_MS = 500;
/** A reading older than this is too old to measure CPU against. */
const STALE_MS = 10_000;
/** Guard's daemon runs under launchd, outside BB's tree, but is part of BB. */
const GUARD_SCRIPT = "/bb-resource-monitor/guard/guard.mjs";
/** `ps` may be slow under heavy load, just when quitting matters most. */
const PS_TIMEOUT_MS = 5000;
/** Linux counts CPU time in ticks of 1/100 s (CLK_TCK). */
const TICKS_PER_SECOND = 100;
/** PowerShell starts slowly and CIM is slower still on a busy Windows. */
const WINDOWS_TIMEOUT_MS = 20_000;
/** Windows' own processes, in lower case: ending one can take Windows down. */
const WINDOWS_SYSTEM = new Set([
  "system",
  "system idle process",
  "registry",
  "memory compression",
  "secure system",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "winlogon.exe",
  "services.exe",
  "lsass.exe",
  "lsaiso.exe",
  "fontdrvhost.exe",
  "dwm.exe",
]);
/** Where the walk up from BB stops: what starts a whole session, not BB. */
const SESSION_ROOTS = new Set([
  "systemd",
  "init",
  "launchd",
  "explorer.exe",
  "svchost.exe",
  "services.exe",
  "wininit.exe",
  "winlogon.exe",
  "userinit.exe",
  "sihost.exe",
  "taskhostw.exe",
]);
/** BB's own programs, wherever they run: its app bundle and its npm package. */
const BB_PROGRAM = /[\\/](bb-app|bb\.app)[\\/]/iu;

/**
 * macOS: `ps -axo pid=,ppid=,rss=,time=,comm=` with the command lines from
 * `ps -axo pid=,args=`. CPU time reads `M:SS.cc`; the name is the
 * executable's file name.
 */
export function parsePs(stats: string, args: string): Proc[] {
  const commands = new Map<number, string>();
  for (const line of args.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (match) commands.set(Number(match[1]), match[2].trim());
  }
  const procs: Proc[] = [];
  for (const line of stats.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+):([\d.]+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const [, pid, ppid, rss, minutes, seconds, comm] = match;
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      name: comm.slice(comm.lastIndexOf("/") + 1),
      command: (commands.get(Number(pid)) || comm).slice(0, COMMAND_CHARS),
      cpuSeconds: Number(minutes) * 60 + Number(seconds),
      memoryBytes: Number(rss) * 1024,
    });
  }
  return procs;
}

/** Linux: `/proc/<pid>/stat`, whose name may hold spaces and parentheses. */
export function parseProcStat(
  stat: string,
  cmdline: string,
  pageSize: number,
): Proc | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const name = stat.slice(open + 1, close);
  const command = cmdline.replaceAll("\0", " ").trim() || name;
  // From the state on: ppid is field 4, utime and stime 14 and 15, rss 24.
  const fields = stat.slice(close + 2).split(" ");
  return {
    pid: Number(stat.slice(0, open)),
    ppid: Number(fields[1]),
    name,
    command: command.slice(0, COMMAND_CHARS),
    cpuSeconds: (Number(fields[11]) + Number(fields[12])) / TICKS_PER_SECOND,
    memoryBytes: Number(fields[21]) * pageSize,
  };
}

let pageSize: Promise<number> | undefined;

async function readProcFs(): Promise<Proc[]> {
  pageSize ??= run("getconf", ["PAGESIZE"]).then(
    (text) => Number(text) || 4096,
    () => 4096,
  );
  const size = await pageSize;
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/u.test(name));
  const procs = await Promise.all(
    pids.map(async (pid) => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
        return parseProcStat(stat, cmdline, size);
      } catch {
        return null; // Gone mid-read.
      }
    }),
  );
  return procs.filter((proc) => proc !== null);
}

/**
 * Windows: tab-separated `ProcessId, ParentProcessId, WorkingSetSize, CPU time
 * in 100 ns units, Name, CommandLine` from Win32_Process. The command line is
 * last, since it may hold tabs; it is empty for other users' processes.
 */
export function parseWin32Processes(text: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const cells = line.split("\t");
    if (cells.length < 5) continue;
    const [pid, ppid, rss, time, name, ...rest] = cells;
    // Pid 0 is the System Idle Process: its "CPU" is the idle time.
    if (!/^\d+$/u.test(pid) || pid === "0") continue;
    const command = rest.join("\t").trim() || name;
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid) || 0,
      name,
      command: command.slice(0, COMMAND_CHARS),
      cpuSeconds: (Number(time) || 0) / 1e7,
      memoryBytes: Number(rss) || 0,
    });
  }
  return procs;
}

const WIN32_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize,",
  "    ([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime), $_.Name, $_.CommandLine))",
  "}",
].join("\n");

async function readWin32(): Promise<Proc[]> {
  return parseWin32Processes(
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WIN32_SCRIPT],
      WINDOWS_TIMEOUT_MS,
    ),
  );
}

async function read(): Promise<Reading> {
  const at = performance.now();
  if (process.platform === "win32") return { at, procs: await readWin32() };
  if (process.platform === "darwin") {
    const [stats, args] = await Promise.all([
      run("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], PS_TIMEOUT_MS),
      run("/bin/ps", ["-axo", "pid=,args="], PS_TIMEOUT_MS),
    ]);
    return { at, procs: parsePs(stats, args) };
  }
  return { at, procs: process.platform === "linux" ? await readProcFs() : [] };
}

/**
 * Why a pid must never be quit, or null: launchd or init, and BB itself. BB
 * is this process, its parents, and their other children (BB's app, helpers,
 * and host daemon), but not the agents the daemon runs.
 */
export function protection(
  procs: Proc[],
  self: number,
  /** On a host machine: this worker's pid, kept apart from the daemon's other children. */
  worker?: number,
): (pid: number) => string | null {
  const parents = new Map(procs.map((proc) => [proc.pid, proc.ppid]));
  const names = new Map(procs.map((proc) => [proc.pid, proc.name.toLowerCase()]));
  const ancestors = new Set<number>();
  let pid = parents.get(self) ?? 0;
  // A session manager such as `systemd --user` is not BB: it also runs the
  // user's services and adopts every orphan.
  for (
    ;
    pid > 1 && !ancestors.has(pid) && !SESSION_ROOTS.has(names.get(pid) ?? "");
    pid = parents.get(pid) ?? 0
  ) {
    ancestors.add(pid);
  }
  const ours = new Set([self, ...ancestors]);
  for (const proc of procs)
    if (
      ancestors.has(proc.ppid) ||
      proc.command.includes(GUARD_SCRIPT) ||
      BB_PROGRAM.test(proc.command)
    )
      ours.add(proc.pid);
  if (worker !== undefined) ours.add(worker);
  const windows = new Set(
    procs
      .filter((proc) => WINDOWS_SYSTEM.has(proc.name.toLowerCase()))
      .map((proc) => proc.pid),
  );
  return (pid) =>
    pid <= 1 || windows.has(pid)
      ? "System process"
      : ours.has(pid)
        ? "Part of BB"
        : null;
}

/**
 * Who the process list protects as BB. On the server, this process. In a host
 * entry, its parent, the host daemon: anchoring at the worker would protect
 * every child of the daemon, agents too.
 */
export function protectionAnchor(hostEntry: boolean) {
  return hostEntry && process.ppid > 1 ? process.ppid : process.pid;
}

/**
 * Each process's share of one core between two readings. A process missing
 * from the first one started after it, so all its CPU time counts.
 */
export function toProcessInfos(
  before: Reading,
  after: Reading,
  self: number,
  worker?: number,
): ProcessInfo[] {
  const seconds = (after.at - before.at) / 1000;
  const previous = new Map(
    before.procs.map((proc) => [proc.pid, proc.cpuSeconds]),
  );
  const guard = protection(after.procs, self, worker);
  // The `ps` or PowerShell a host entry starts to read the list isn't listed.
  const procs =
    worker === undefined
      ? after.procs
      : after.procs.filter((proc) => proc.ppid !== worker);
  return procs.map(({ pid, name, command, cpuSeconds, memoryBytes }) => {
    const used = cpuSeconds - (previous.get(pid) ?? 0);
    return {
      pid,
      name,
      command,
      cpuPercent: seconds > 0 ? Math.max(0, (100 * used) / seconds) : 0,
      memoryBytes,
      protected: guard(pid) !== null,
    };
  });
}

/**
 * Windows: `taskkill` asks a program to close, as its window's close button
 * does; `/F` ends it. Returns why it failed, or null; gone counts as quit.
 */
function taskkill(pid: number, force: boolean): Promise<string | null> {
  const args = force ? ["/F", "/PID", String(pid)] : ["/PID", String(pid)];
  return new Promise((resolve) =>
    execFile("taskkill.exe", args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(null);
      resolve(taskkillReason(`${stdout}\n${stderr}`));
    }),
  );
}

/** Why taskkill failed, from its message. */
export function taskkillReason(text: string): string | null {
  if (/not found/iu.test(text)) return null;
  if (/access is denied/iu.test(text)) return "Not permitted";
  if (/only be terminated forcefully|forcefully/iu.test(text)) return "Needs Force Quit";
  return text.trim().split(/\r?\n/u).pop()?.replace(/^ERROR:\s*/u, "") || "Couldn’t quit";
}

/** Sends the signal; returns why it failed, or null. Already gone counts as quit. */
function kill(pid: number, force: boolean): string | null {
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return null;
    return code === "EPERM" ? "Not permitted" : (error as Error).message;
  }
}

/**
 * The process list, with CPU between readings, and quitting. `self` anchors
 * BB's protected processes; `worker` is this process when it is a host entry.
 */
export function createProcessMonitor(
  self = process.pid,
  worker?: number,
) {
  let last: Reading | null = null;
  let list: ProcessInfo[] | null = null;
  let pending: Promise<ProcessInfo[]> | null = null;

  async function refresh(): Promise<ProcessInfo[]> {
    if (!last || performance.now() - last.at > STALE_MS) last = await read();
    const wait = last.at + MIN_SPAN_MS - performance.now();
    if (wait > 0) await sleep(wait);
    const next = await read();
    list = toProcessInfos(last, next, self, worker);
    last = next;
    return list;
  }

  return {
    async listProcesses(): Promise<ProcessInfo[]> {
      if (list && last && performance.now() - last.at < FRESH_MS) return list;
      pending ??= refresh().finally(() => {
        pending = null;
      });
      return pending;
    },
    async quitProcesses({ pids, force }: { pids: number[]; force: boolean }) {
      // Only pids in a fresh reading get a signal, so its protection covers them.
      const { procs } = await read();
      const guard = protection(procs, self, worker);
      const alive = new Set(procs.map((proc) => proc.pid));
      const failed: { pid: number; reason: string }[] = [];
      const unique = [...new Set(pids)];
      for (const pid of unique) {
        const reason =
          guard(pid) ??
          (!alive.has(pid)
            ? null
            : process.platform === "win32"
              ? await taskkill(pid, force)
              : kill(pid, force));
        if (reason) failed.push({ pid, reason });
      }
      // A refresh that read before the signals would bring the processes back.
      await pending?.catch(() => {});
      list = null;
      return { quit: unique.length - failed.length, failed };
    },
  };
}
