// The Windows install flow, with fake steps in place of processes and fake downloads:
// what runs, in what order, with which environment and limits, and what reaches the log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installWindows, WINDOWS_INSTALL_BUDGET_MS, type InstallRequest, type Machine } from "../src/host-impl";
import type { Spawned, SpawnOptions } from "../src/spawn";

const KEY = "made-up-team-key-0123456789";
const RELAY = "https://relay.example.invalid";
const TAG = "v0.14.1";
const LATEST = `https://github.com/neoromantic/ai-usage/releases/tag/${TAG}`;
const EXE = path.join("C:\\Users\\test\\AppData\\Local", "Programs", "ai-usage", "ai-usage.exe");

interface Call {
  file: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

type Answer = Partial<Spawned> & { onLine?: Array<[string, "out" | "err"]> };

/** Fake steps: each call is recorded and answered by its first argument pattern. */
function fakeSteps(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const run = (async (file: string, args: string[], options: SpawnOptions): Promise<Spawned> => {
    const key = args.includes("-File") ? "installer" : args.join(" ");
    calls.push({ file, args, env: options.env, timeoutMs: options.timeoutMs, signal: options.signal });
    const answer = answers[key] ?? {};
    for (const [line, stream] of answer.onLine ?? []) options.onLine?.(line, stream);
    return { code: 0, timedOut: false, stdout: "", stderr: "", ...answer };
  }) as typeof import("../src/spawn").run;
  return { calls, run };
}

function machine(tempDir: string, fetch: typeof globalThis.fetch): Machine {
  return {
    env: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", USERPROFILE: "C:\\Users\\test" },
    dirs: [],
    platform: "win32",
    home: "C:\\Users\\test",
    tempDir,
    fetch,
  } as unknown as Machine;
}

const goodFetch = (async (url: string | URL | Request) => {
  const href = String(url);
  if (href.endsWith("/releases/latest")) return new Response(null, { status: 302, headers: { location: LATEST } });
  return new Response("# installer", { status: 200 });
}) as typeof globalThis.fetch;

function request(lines: string[] = []): InstallRequest & { seen: string[] } {
  const seen = [...lines];
  return { teamKey: KEY, relay: RELAY, onLine: (line) => seen.push(line), seen };
}

describe("Windows install flow", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ai-usage-winflow-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("installs, collects, and leaves a registered task alone", async () => {
    const steps = fakeSteps({ "schedule status": { stdout: `registered: ${EXE} runs every 15m0s\n` } });
    const req = request();
    const out = await installWindows(machine(dir, goodFetch), req, { run: steps.run });
    expect(out.ok).toBe(true);
    const names = steps.calls.map((c) => (c.args.includes("-File") ? "installer" : c.args.join(" ")));
    expect(names).toEqual(["installer", "collect --quiet", "schedule status"]);
    expect(steps.calls[1]!.file).toBe(EXE);
  });

  test("registers the task when status says it is not registered", async () => {
    const steps = fakeSteps({
      "schedule status": { stdout: "not registered\n" },
      "schedule install": { stdout: "registered C:\\x\\ai-usage.exe\n" },
    });
    const out = await installWindows(machine(dir, goodFetch), request(), { run: steps.run });
    expect(out.ok).toBe(true);
    expect(steps.calls.map((c) => c.args[0])).toEqual(["-NoProfile", "collect", "schedule", "schedule"]);
    expect(steps.calls.at(-1)!.args).toEqual(["schedule", "install"]);
  });

  test("a failed installer runs neither collect nor the schedule", async () => {
    const steps = fakeSteps({ installer: { code: 1, stderr: "ai-usage install: no checksum\n" } });
    const out = await installWindows(machine(dir, goodFetch), request(), { run: steps.run });
    expect(out.ok).toBe(false);
    expect(steps.calls.length).toBe(1);
    expect(out.message).toContain("no checksum");
  });

  test("a timed-out status does not register the task", async () => {
    const steps = fakeSteps({ "schedule status": { code: null, timedOut: true } });
    const out = await installWindows(machine(dir, goodFetch), request(), { run: steps.run });
    expect(out.ok).toBe(false);
    expect(steps.calls.some((c) => c.args.includes("install"))).toBe(false);
  });

  test("an unclear status does not register the task", async () => {
    const steps = fakeSteps({ "schedule status": { stdout: "registered, but for a different binary path\n" } });
    await installWindows(machine(dir, goodFetch), request(), { run: steps.run });
    expect(steps.calls.some((c) => c.args.includes("install"))).toBe(false);
  });

  test("the installer's standard output never reaches the log; its standard error does", async () => {
    const steps = fakeSteps({
      installer: { onLine: [["REPORT LINE that must stay out", "out"], ["ai-usage install: a note", "err"]] },
      "schedule status": { stdout: `registered: ${EXE}\n`, onLine: [["STATUS OUTPUT out", "out"]] },
    });
    const req = request();
    await installWindows(machine(dir, goodFetch), req, { run: steps.run });
    expect(req.seen.some((line) => line.includes("REPORT LINE"))).toBe(false);
    expect(req.seen.some((line) => line.includes("a note"))).toBe(true);
    expect(req.seen.some((line) => line.includes("STATUS OUTPUT"))).toBe(false);
  });

  test("the team key and relay go to the installer only", async () => {
    const steps = fakeSteps({ "schedule status": { stdout: `registered: ${EXE}\n` } });
    await installWindows(machine(dir, goodFetch), request(), { run: steps.run });
    const [installer, ...after] = steps.calls;
    expect(installer!.env.AI_USAGE_TEAM_KEY).toBe(KEY);
    expect(installer!.env.AI_USAGE_RELAY).toBe(RELAY);
    for (const call of after) {
      expect(call.env.AI_USAGE_TEAM_KEY).toBeUndefined();
      expect(call.env.AI_USAGE_RELAY).toBeUndefined();
      expect(call.args.join(" ")).not.toContain(KEY);
    }
  });

  test("the steps share one budget that stays under the server's install deadline", async () => {
    const steps = fakeSteps({ "schedule status": { stdout: `registered: ${EXE}\n` } });
    await installWindows(machine(dir, goodFetch), request(), { run: steps.run });
    const total = steps.calls.reduce((sum, c) => sum + c.timeoutMs, 0);
    expect(steps.calls[0]!.timeoutMs).toBeLessThanOrEqual(18 * 60_000);
    expect(WINDOWS_INSTALL_BUDGET_MS).toBeLessThan(30 * 60_000);
    // Each step is capped by what is left of the budget when it starts, so the steps' limits fit it.
    expect(steps.calls[0]!.timeoutMs + steps.calls[1]!.timeoutMs + steps.calls[2]!.timeoutMs).toBeLessThanOrEqual(WINDOWS_INSTALL_BUDGET_MS + 1_000);
    expect(total).toBeGreaterThan(0);
  });

  test("a download that never answers is cut off, and the request's cancellation reaches it", async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof globalThis.fetch;
    const ac = new AbortController();
    const steps = fakeSteps({});
    const started = Date.now();
    const pending = installWindows(machine(dir, hanging), { ...request(), signal: ac.signal }, { run: steps.run });
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(steps.calls.length).toBe(0);
  });
});
