// What the host entry does on a BB machine, with the machine passed in so
// tests can give it a made-up one.
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { allowed } from "./args.js";
import type { InstallOutput, Probe, RunInput, RunOutput } from "./contract.js";
import { candidates, type Env } from "./env.js";
import { errorMessage, redact } from "./message.js";
import { run } from "./spawn.js";
import { atLeast, STATUS_SAFE } from "./version.js";

export const REPO = "neoromantic/ai-usage";
const AGENT = "io.github.neoromantic.ai-usage";

export interface Machine {
  /** The clean environment every run gets. */
  env: Env;
  home: string;
  /** The folders the installer and package managers put ai-usage in: standardDirs(home). */
  dirs: string[];
  platform: NodeJS.Platform;
  arch: string;
  uid: number | null;
  user: string;
  tempDir: string;
  fetch: typeof fetch;
}

/**
 * The clean PATH with the standard folders after it, where the tools ai-usage reads often are.
 * AI_USAGE_CALLER marks the runs as BB's, so the reports it reads every minute record no usage
 * stats.
 */
export function childEnv(m: Machine, aiHome: string | null): Env {
  const dirs = (m.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "");
  for (const d of m.dirs) if (!dirs.includes(d) && existsSync(d)) dirs.push(d);
  const env: Env = { ...m.env, PATH: dirs.join(path.delimiter), AI_USAGE_CALLER: "bb" };
  if (aiHome !== null) env.AI_USAGE_HOME = aiHome;
  return env;
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first ai-usage on PATH or in the standard folders. */
export async function findBinary(m: Machine): Promise<string | null> {
  for (const file of candidates(m.env, m.dirs, m.platform === "win32" ? "ai-usage.exe" : "ai-usage")) {
    if (await executable(file)) return file;
  }
  return null;
}

/** A launch agent or a crontab line of ai-usage is there. */
async function scheduleEntry(m: Machine): Promise<boolean> {
  if (m.platform === "darwin") return existsSync(path.join(m.home, "Library/LaunchAgents", `${AGENT}.plist`));
  if (m.platform !== "linux") return false;
  const r = await run("crontab", ["-l"], { env: m.env, timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.split("\n").some((line) => line.trimEnd().endsWith("# ai-usage"));
}

/** The program the launch agent runs, read by plutil, when it is an ai-usage binary there. */
async function agentProgram(m: Machine): Promise<string | null> {
  if (m.platform !== "darwin") return null;
  const plist = path.join(m.home, "Library/LaunchAgents", `${AGENT}.plist`);
  const r = await run("plutil", ["-extract", "ProgramArguments.0", "raw", "-o", "-", plist], { env: m.env, timeoutMs: 10_000 });
  const program = r.stdout.trim();
  if (r.code !== 0 || !path.isAbsolute(program) || path.basename(program) !== "ai-usage") return null;
  return (await executable(program)) ? program : null;
}

function appInstalled(m: Machine): boolean {
  if (m.platform !== "darwin") return false;
  return [path.join(m.home, "Applications/AI Usage.app"), "/Applications/AI Usage.app"].some((p) => existsSync(p));
}

async function macosVersion(m: Machine): Promise<string | null> {
  if (m.platform !== "darwin") return null;
  const r = await run("sw_vers", ["-productVersion"], { env: m.env, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function runCommand(m: Machine, input: RunInput, signal?: AbortSignal): Promise<RunOutput> {
  const base = path.basename(input.bin);
  if (!path.isAbsolute(input.bin) || (base !== "ai-usage" && base !== "ai-usage.exe")) {
    throw new Error("not an ai-usage binary");
  }
  if (!allowed(input.args)) throw new Error(`ai-usage ${input.args[0] ?? ""} is not a command this plugin runs`);
  const r = await run(input.bin, input.args, {
    env: childEnv(m, input.aiHome),
    cwd: m.home,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
    signal,
  });
  let json: unknown = null;
  if (input.json && r.code === 0) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = null;
    }
  }
  const message = r.timedOut
    ? `ai-usage did not finish in ${Math.round(input.timeoutMs / 1000)} seconds`
    : r.code === 0
      ? ""
      : errorMessage(r.stderr, r.stdout) || `ai-usage exited with status ${r.code ?? "?"}`;
  return {
    code: r.code,
    timedOut: r.timedOut,
    stdout: input.json ? "" : redactUnlessKey(input.args, r.stdout),
    json,
    message: redact(message),
  };
}

/** `team key` is the one command whose output is the key, on purpose. */
function redactUnlessKey(args: string[], text: string): string {
  return args[0] === "team" && args[1] === "key" ? text : redact(text);
}

interface StatusInstall {
  schedule?: { state?: string; program?: string | null; home?: string | null };
  home?: string;
}

export async function probe(m: Machine): Promise<Probe> {
  const out: Probe = {
    platform: m.platform,
    arch: m.arch,
    uid: m.uid,
    user: m.user,
    macos: await macosVersion(m),
    bin: null,
    aiHome: null,
    version: null,
    status: null,
    canUninstall: false,
    scheduleEntry: false,
    app: appInstalled(m),
    error: null,
  };
  let bin = await findBinary(m);
  if (bin === null) {
    out.scheduleEntry = await scheduleEntry(m);
    // A launch agent names the binary it runs, wherever that is: take it,
    // and status --json then says the rest.
    bin = out.scheduleEntry ? await agentProgram(m) : null;
    if (bin === null) return out;
  }
  const ask = (file: string, aiHome: string | null, args: string[], json = false) =>
    runCommand(m, { bin: file, aiHome, args, stdin: null, json, timeoutMs: 30_000 });
  const version = await ask(bin, null, ["version"]);
  out.version = version.code === 0 ? version.stdout.trim().split(/\s+/)[0] ?? null : null;
  if (version.code !== 0) out.error = version.message;
  // Before v0.11.0, status --json made a team key and a device id on a
  // machine that had not collected; report --json never did.
  if (atLeast(out.version, STATUS_SAFE)) {
    const status = await ask(bin, null, ["status", "--json"], true);
    out.status = status.json;
    const install = (status.json as { install?: StatusInstall } | null)?.install;
    const program = install?.schedule?.program ?? null;
    out.aiHome = install?.schedule?.home ?? null;
    // The copy the scheduler runs is the one that collects.
    if (program !== null && program !== bin && path.isAbsolute(program) && (await executable(program))) {
      bin = program;
      const v = await ask(bin, out.aiHome, ["version"]);
      out.version = v.code === 0 ? v.stdout.trim().split(/\s+/)[0] ?? out.version : out.version;
      const again = await ask(bin, out.aiHome, ["status", "--json"], true);
      if (again.json !== null) out.status = again.json;
    }
  }
  out.bin = bin;
  const help = await ask(bin, out.aiHome, ["--help"]);
  out.canUninstall = /ai-usage uninstall/.test(help.stdout);
  return out;
}

/** The relay this machine's ai-usage uses, and the one its binary has built in. */
export async function relays(m: Machine, bin: string, aiHome: string | null): Promise<{ configured: string | null; builtIn: string | null }> {
  const read = async (home: string | null) => {
    const r = await runCommand(m, { bin, aiHome: home, args: ["relay", "show"], stdin: null, json: false, timeoutMs: 30_000 });
    const url = r.stdout.trim();
    return r.code === 0 && /^https?:\/\//.test(url) ? url : null;
  };
  // A state folder of its own holds no relay of its own, so its relay is the built-in one.
  const empty = path.join(m.tempDir, "empty-home");
  await mkdir(empty, { recursive: true });
  return { configured: await read(aiHome), builtIn: await read(empty) };
}

/** The tag of the latest release, from the releases/latest redirect, without GitHub's rate-limited API. */
export async function latestTag(m: Machine, parent?: AbortSignal): Promise<string> {
  const r = await m.fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", signal: boundSignal(60_000, parent) });
  const location = r.headers.get("location") ?? "";
  const tag = /\/releases\/tag\/(v\d+\.\d+\.\d+)$/.exec(location)?.[1];
  if (tag === undefined) throw new Error(`could not tell the latest ai-usage release (HTTP ${r.status})`);
  return tag;
}

export interface InstallRequest {
  teamKey: string | null;
  relay: string | null;
  /** Each line of the installer's output, with any key in it replaced. */
  onLine: (line: string) => void;
  signal?: AbortSignal;
  /** Extra environment for tests: a made-up HOME and a local relay. */
  extraEnv?: Env;
}

/**
 * The arguments that run the release's install.ps1. The script is a file, so nothing
 * secret is on the command line: the team key and relay go in the environment
 * (see windowsInstallEnv).
 */
export function windowsInstallArgs(file: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file];
}

/**
 * The environment of the Windows install. install.ps1 reads AI_USAGE_TEAM_KEY and
 * AI_USAGE_RELAY itself and joins the team on its first run. The key is never an argument.
 */
export function windowsInstallEnv(m: Machine, req: InstallRequest, tag: string): Env {
  const env: Env = {
    ...childEnv(m, null),
    AI_USAGE_DOWNLOAD_URL: `https://github.com/${REPO}/releases/download/${tag}`,
    ...req.extraEnv,
  };
  if (req.teamKey !== null && req.teamKey.trim() !== "") env.AI_USAGE_TEAM_KEY = req.teamKey.trim();
  if (req.relay !== null && req.relay.trim() !== "") env.AI_USAGE_RELAY = req.relay.trim();
  return env;
}

/** The installed binary: install.ps1 puts it in %LOCALAPPDATA%\Programs\ai-usage. */
export function windowsBinary(env: Env): string {
  return path.join(env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? "", "AppData", "Local"), "Programs", "ai-usage", "ai-usage.exe");
}

/** The longest the whole Windows install may take; the server's install deadline is 30 minutes. */
export const WINDOWS_INSTALL_BUDGET_MS = 25 * 60_000;
/** The installer's own limit; collect and the schedule steps get what is left after it. */
const WINDOWS_INSTALLER_MS = 18 * 60_000;
const WINDOWS_COLLECT_MS = 5 * 60_000;
const WINDOWS_STEP_MS = 60_000;
/** A download that stalls gives up after this. */
const DOWNLOAD_MS = 60_000;

/** A signal that ends with the parent (when given) or after `ms`, whichever comes first. */
export function boundSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

/** The environment for the steps after the installer: the team key and relay are not needed there, so they are not passed. */
export function withoutSecrets(env: Env): Env {
  const out: Env = { ...env };
  delete out.AI_USAGE_TEAM_KEY;
  delete out.AI_USAGE_RELAY;
  return out;
}

export interface WindowsSteps {
  run: typeof run;
}

/**
 * Windows: the release's install.ps1, then one collect, then the scheduled task checked.
 * Only the installer's and collect's standard error reaches the job log: their standard output
 * is the first run's report, which stays out of the log. The steps share one budget.
 */
export async function installWindows(m: Machine, req: InstallRequest, steps: WindowsSteps = { run }): Promise<InstallOutput> {
  const started = Date.now();
  const left = (max: number) => Math.max(1_000, Math.min(max, WINDOWS_INSTALL_BUDGET_MS - (Date.now() - started)));
  const tag = await latestTag(m, req.signal);
  req.onLine(`installing ai-usage ${tag}`);
  const script = await m.fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/install.ps1`, { signal: boundSignal(DOWNLOAD_MS, req.signal) });
  if (!script.ok) throw new Error(`could not download install.ps1 of ${tag} (HTTP ${script.status})`);
  const file = path.join(m.tempDir, `install-${tag}.ps1`);
  await writeFile(file, await script.text(), { mode: 0o600 });
  const env = windowsInstallEnv(m, req, tag);
  const later = withoutSecrets(env);
  const tail: string[] = [];
  const onErr = (raw: string, stream: "out" | "err") => {
    if (stream !== "err") return;
    // eslint-disable-next-line no-control-regex
    const line = redact(raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
    tail.push(line);
    if (tail.length > 20) tail.shift();
    req.onLine(line);
  };
  const fail = (code: number | null, message: string): InstallOutput => ({ ok: false, code, tag, message: redact(message) });

  const installer = await steps.run("powershell", windowsInstallArgs(file), {
    env,
    cwd: m.tempDir,
    stdin: null,
    timeoutMs: left(WINDOWS_INSTALLER_MS),
    signal: req.signal,
    onLine: onErr,
  });
  if (installer.timedOut) return fail(installer.code, "the installer did not finish in 18 minutes");
  if (installer.code !== 0) {
    return fail(installer.code, errorMessage(installer.stderr.replace(/^ai-usage install: /gm, "ai-usage: "), "") || (tail.at(-1) ?? "the installer failed"));
  }

  const exe = windowsBinary(env);
  const collected = await steps.run(exe, ["collect", "--quiet"], {
    env: later,
    cwd: m.tempDir,
    stdin: null,
    timeoutMs: left(WINDOWS_COLLECT_MS),
    signal: req.signal,
    onLine: onErr,
  });
  if (collected.timedOut) return fail(collected.code, "the first collect did not finish in 5 minutes");
  if (collected.code !== 0) return fail(collected.code, `the first collect failed: ${collected.stderr.trim() || "ai-usage collect failed"}`);

  // Registers the task only when status positively says it is not registered. A status that
  // times out, fails, or says anything else leaves the task alone.
  const status = await steps.run(exe, ["schedule", "status"], { env: later, cwd: m.tempDir, stdin: null, timeoutMs: left(WINDOWS_STEP_MS), signal: req.signal });
  if (status.timedOut) return fail(status.code, "schedule status did not answer in 60 seconds, so the scheduled task was not changed");
  if (status.code !== 0) return fail(status.code, "could not read the scheduled task's status, so it was not changed");
  if (/^registered/m.test(status.stdout)) return { ok: true, code: 0, tag, message: `installed ai-usage ${tag}` };
  if (!/^not registered\s*$/m.test(status.stdout)) {
    return fail(status.code, "the scheduled task's status is unclear, so it was not changed");
  }
  const added = await steps.run(exe, ["schedule", "install"], { env: later, cwd: m.tempDir, stdin: null, timeoutMs: left(WINDOWS_STEP_MS), signal: req.signal });
  if (added.timedOut) return fail(added.code, "schedule install did not finish in 60 seconds");
  if (added.code !== 0) return fail(added.code, `the scheduled task could not be registered: ${added.stderr.trim() || "ai-usage schedule install failed"}`);
  return { ok: true, code: 0, tag, message: `installed ai-usage ${tag}` };
}

/**
 * Runs the release's own install.sh, from the latest release's tag, so the
 * binary and the script come from the same release. The menu bar app stays
 * out (the panel offers it later) and so do shell profiles.
 */
export async function install(m: Machine, req: InstallRequest): Promise<InstallOutput> {
  if (m.platform === "win32") return installWindows(m, req);
  if (m.platform !== "darwin" && m.platform !== "linux") {
    return { ok: false, code: null, tag: null, message: "ai-usage installs from BB on macOS, Linux and Windows only" };
  }
  const tag = await latestTag(m);
  req.onLine(`installing ai-usage ${tag}`);
  const script = await m.fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/install.sh`);
  if (!script.ok) throw new Error(`could not download install.sh of ${tag} (HTTP ${script.status})`);
  const file = path.join(m.tempDir, `install-${tag}.sh`);
  await writeFile(file, await script.text(), { mode: 0o600 });
  const env: Env = {
    ...childEnv(m, null),
    AI_USAGE_DOWNLOAD_URL: `https://github.com/${REPO}/releases/download/${tag}`,
    AI_USAGE_NO_APP: "1",
    AI_USAGE_NO_MODIFY_PATH: "1",
    ...req.extraEnv,
  };
  if (req.teamKey !== null && req.teamKey.trim() !== "") env.AI_USAGE_TEAM_KEY = req.teamKey.trim();
  if (req.relay !== null && req.relay.trim() !== "") env.AI_USAGE_RELAY = req.relay.trim();
  const tail: string[] = [];
  const r = await run("sh", [file], {
    env,
    cwd: m.tempDir,
    stdin: null,
    timeoutMs: 29 * 60 * 1000,
    signal: req.signal,
    // The installer says what it does on standard error; standard output is
    // the first run's report, which stays out of the log.
    onLine: (raw, stream) => {
      if (stream === "out") return;
      // eslint-disable-next-line no-control-regex
      const line = redact(raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
      tail.push(line);
      if (tail.length > 20) tail.shift();
      req.onLine(line);
    },
  });
  const ok = r.code === 0 && !r.timedOut;
  const message = ok
    ? `installed ai-usage ${tag}`
    : r.timedOut
      ? "the installer did not finish in 29 minutes"
      : errorMessage(r.stderr.replace(/^ai-usage install: /gm, "ai-usage: "), "") || (tail.at(-1) ?? "the installer failed");
  return { ok, code: r.code, tag, message: redact(message) };
}
