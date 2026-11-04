// Runs a child process with a deadline, reading both pipes while it runs,
// since a report is larger than a pipe holds.
import { spawn } from "node:child_process";
import type { Env } from "./env.js";

export interface Spawned {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  env: Env;
  cwd?: string;
  stdin?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called with each line of both pipes as it comes, without the newline. */
  onLine?: (line: string, stream: "out" | "err") => void;
  maxStdout?: number;
}

const MAX_STDERR = 256 * 1024;
/** After a kill, how long to wait for the pipes to close before answering anyway. */
export const GIVE_UP_MS = 8000;

/** Stops the child and, on Windows, everything it started (taskkill /T), so nothing keeps the pipes open. */
function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const kill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    kill.on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
}

export function run(command: string, args: string[], options: SpawnOptions): Promise<Spawned> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: options.env,
        cwd: options.cwd,
        stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, timedOut: false, stdout: "", stderr: `ai-usage: could not start ${command}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const maxStdout = options.maxStdout ?? 8 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const pending = { out: "", err: "" };
    const lines = (which: "out" | "err", chunk: string) => {
      if (options.onLine === undefined) return;
      const text = pending[which] + chunk;
      const parts = text.split(/\r?\n/);
      pending[which] = parts.pop() ?? "";
      for (const line of parts) options.onLine(line, which);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < maxStdout) stdout += chunk;
      lines("out", chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
      lines("err", chunk);
    });
    let killer: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;
    const stop = () => {
      if (done) return;
      killTree(child);
      killer = setTimeout(() => child.kill("SIGKILL"), 5000);
      // A grandchild that inherited the pipes keeps 'close' from firing, so answer after a grace period anyway.
      giveUp = setTimeout(() => finish(null), GIVE_UP_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killer !== undefined) clearTimeout(killer);
      if (giveUp !== undefined) clearTimeout(giveUp);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.onLine !== undefined) {
        if (pending.out !== "") options.onLine(pending.out, "out");
        if (pending.err !== "") options.onLine(pending.err, "err");
      }
      resolve({ code, timedOut, stdout, stderr });
    };
    child.on("error", (error) => {
      stderr += `ai-usage: could not start ${command}: ${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (options.stdin != null && child.stdin !== null) {
      // A child that exits without reading closes the pipe; that is its answer.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}
