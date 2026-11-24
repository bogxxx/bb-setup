// Guard's runtime: launchd runs `<BB's binary> guard.mjs` with
// ELECTRON_RUN_AS_NODE=1. Every 2 s: one `ps`, policy.mjs decides, this acts
// and writes status.json. Flags: --home <dir>, --dry-run (log, never act).
import { execFile } from "node:child_process";
import {
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import {
  decide,
  newState,
  note,
  parsePs,
  release,
  settle,
  statusOf,
  toSaved,
} from "./policy.mjs";

const TICK_MS = 2000,
  STATUS_MS = 5000,
  LOG_MAX = 1 << 20;
/** An old heartbeat: the plugin is off or gone, so Pause all is too; a day: uninstall. */
const STALE_MS = 10 * 60e3,
  ORPHAN_MS = 24 * 3600e3;
const LABEL = "app.getbb.resource-monitor.guard";
const SIGNALS = /** @type {const} */ ({
  stop: "SIGSTOP",
  cont: "SIGCONT",
  term: "SIGTERM",
  kill: "SIGKILL",
});

const { values } = parseArgs({
  options: { home: { type: "string" }, "dry-run": { type: "boolean" } },
});
const home =
  values.home ??
  join(os.homedir(), "Library/Application Support/bb-resource-monitor/guard");
const dryRun = values["dry-run"] ?? false;
const at = (/** @type {string} */ name) => join(home, name);
const log = (/** @type {string} */ line) =>
  console.log(`${new Date().toISOString()} ${line}`);
/** @returns {Promise<Record<string, unknown>>} */
const readJson = (/** @type {string} */ name) =>
  readFile(at(name), "utf8")
    .then(
      (text) => JSON.parse(text) ?? {},
      () => ({}),
    )
    .catch(() => ({}));

/** A program's output; a stuck one is killed after 5 s. @param {string} file @param {string[]} args */
const run = async (file, args) =>
  (
    await promisify(execFile)(file, args, {
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 64 << 20,
    })
  ).stdout;

const readPs = async () =>
  parsePs(
    await run("/bin/ps", [
      "-axo",
      "pid=,ppid=,nice=,stat=,time=,etime=,tty=,args=",
    ]),
    Date.now(),
  );

/** Writes a temp file and renames it, so readers never see half a file. */
async function write(/** @type {string} */ name, /** @type {unknown} */ value) {
  await writeFile(at(`${name}.tmp`), `${JSON.stringify(value)}\n`);
  await rename(at(`${name}.tmp`), at(name));
}

const cpuTimes = () =>
  os.cpus().reduce(
    ({ busy, total }, { times: t }) => {
      const used = t.user + t.nice + t.sys + t.irq;
      return { busy: busy + used, total: total + used + t.idle };
    },
    { busy: 0, total: 0 },
  );

/** @param {import("./policy.mjs").Action} a @returns {Promise<string | null>} errno, or null */
async function perform(a) {
  if (a.pid <= 1 || a.pid === process.pid) return null;
  log(`${dryRun ? "dry-run " : ""}${a.type} ${a.pid} ${a.name}`);
  if (dryRun) return null;
  try {
    if (a.type === "nice") os.setPriority(a.pid, 10);
    else if (a.type === "bg" || a.type === "unbg") {
      await run("/usr/sbin/taskpolicy", [
        a.type === "bg" ? "-b" : "-B",
        "-p",
        String(a.pid),
      ]);
    } else process.kill(a.pid, SIGNALS[a.type]);
    return null;
  } catch (error) {
    const e =
      /** @type {{ code?: unknown, info?: { code: string }, stderr?: string }} */ (
        error
      );
    const said = /no such process/iu.test(`${e.stderr}`)
      ? "ESRCH"
      : /not permitted/iu.test(`${e.stderr}`) && "EPERM";
    const code =
      e.info?.code ?? (said || (typeof e.code === "string" ? e.code : "EFAIL"));
    if (code !== "ESRCH") log(`error: ${a.type} ${a.pid}: ${code}`);
    return code;
  }
}

const started = Date.now();
const s = newState(await readJson("state.json"), started - os.uptime() * 1000);
let cpu = cpuTimes(),
  saved = JSON.stringify(toSaved(s)),
  status = "",
  statusAt = 0;
/** @type {{ code: number, why: string, uninstall?: boolean } | null} */
let stopping = null;
let done = false;
const wake = new AbortController();
/** @param {number} code @param {string} why */
function stop(code, why, uninstall = false) {
  stopping ??= { code, why, uninstall };
  wake.abort();
}
for (const [signal, code] of /** @type {const} */ ([
  ["SIGTERM", 143],
  ["SIGINT", 130],
])) {
  // After cleanup, a signal (launchctl bootout) only ends the process.
  process.on(signal, () =>
    done ? process.exit(stopping?.code ?? code) : stop(code, `got ${signal}`),
  );
}

/** state.json before acting, so a guard that dies midway leaves nothing unknown held. */
async function save() {
  const text = JSON.stringify(toSaved(s));
  if (!dryRun && text !== saved)
    await write("state.json", toSaved(s)).then(() => (saved = text));
}

async function tick() {
  const config = await readJson("config.json");
  const app =
    typeof config.bbAppPath === "string"
      ? config.bbAppPath
      : (/^(.*?\.app)\//u.exec(process.execPath)?.[1] ?? "");
  if (!app.endsWith(".app"))
    return stop(0, `${app || process.execPath} is not inside an app bundle`);
  if (config.enabled === false) return stop(0, "Guard is turned off");
  const now = Date.now();
  const beat =
    Number(await readFile(at("heartbeat"), "utf8").catch(() => "")) || started;
  if (now - beat > ORPHAN_MS) return stop(0, "the plugin is gone", true);
  const pauseAll =
    (await readJson("control.json")).pauseAll === true && now - beat < STALE_MS;
  const procs = await readPs();
  const times = cpuTimes();
  const busy =
    (100 * (times.busy - cpu.busy)) / Math.max(1, times.total - cpu.total);
  cpu = times;
  const acts = decide(
    procs,
    s,
    { app, self: process.pid, pauseAll, busy },
    now,
  );
  await save().catch((error) => log(`error: ${error.message}`)); // Act anyway; the next save retries.
  for (const a of acts) settle(s, a, await perform(a), Date.now());
  await save();
}

/** status.json when it changes, and every 5 s so the server sees Guard is alive. */
async function writeStatus() {
  const now = Date.now(),
    next = statusOf(s, now),
    text = JSON.stringify({ ...next, updatedAt: 0 });
  if (text === status && now - statusAt < STATUS_MS) return;
  await write("status.json", next);
  [status, statusAt] = [text, now];
}

while (!stopping) {
  await tick().catch((/** @type {Error} */ error) => {
    log(`error: ${error.message}`);
    note(s, Date.now(), error.message.split("\n")[0], true);
  });
  if (!stopping)
    await writeStatus().catch((error) => log(`error: ${error.message}`));
  const logSize = (await stat(at("guard.log")).catch(() => null))?.size ?? 0;
  if (logSize > LOG_MAX) await truncate(at("guard.log"), 0);
  if (!stopping)
    await sleep(TICK_MS, null, { signal: wake.signal }).catch(() => {});
}

const { code, why, uninstall } = /** @type {NonNullable<typeof stopping>} */ (
  stopping
);
log(`Stopping: ${why}`);
const procs = await readPs().catch(() => null);
for (const a of release(s, procs)) settle(s, a, await perform(a), Date.now());
await save().catch(() => {});
done = true;
if (uninstall) {
  const plist = join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`),
    target = `gui/${process.getuid?.()}/${LABEL}`;
  log(
    `${dryRun ? "dry-run " : ""}uninstall: remove ${plist}, launchctl bootout ${target}`,
  );
  // bootout sends SIGTERM, which now only ends the process.
  if (!dryRun)
    await rm(plist, { force: true })
      .then(() => run("/bin/launchctl", ["bootout", target]))
      .catch(() => {});
}
process.exit(code);
