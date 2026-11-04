// A call to a machine always ends: a hard limit on the server, and a run on the
// machine that answers at its timeout even when a child it started keeps the
// pipes open. A machine whose probe failed shows an error, not loading.
import { describe, expect, test } from "bun:test";
import { withDeadline } from "../src/deadline";
import { run } from "../src/spawn";
import { phaseOf, type HostFacts } from "../src/phase";

describe("withDeadline", () => {
  test("rejects with the machine's name when it does not answer in time", async () => {
    const never = new Promise<never>(() => {});
    const started = Date.now();
    await expect(withDeadline(never, 50, "predator")).rejects.toThrow("predator did not answer in 0 seconds");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("passes the answer through when it comes in time", async () => {
    expect(await withDeadline(Promise.resolve(42), 1000, "predator")).toBe(42);
  });

  test("passes a failure through unchanged", async () => {
    await expect(withDeadline(Promise.reject(new Error("refused")), 1000, "predator")).rejects.toThrow("refused");
  });
});

describe("run on a machine", () => {
  test("answers at its timeout even when a grandchild keeps its output open", async () => {
    // The child starts a grandchild that inherits its pipes and outlives it; a kill of the child alone never closes them.
    const script = 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" }); setTimeout(() => {}, 60000);';
    const started = Date.now();
    const out = await run(process.execPath, ["-e", script], { env: process.env as Record<string, string>, timeoutMs: 500 });
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe("a machine whose probe failed", () => {
  const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
    host: { status: "connected", type: "persistent" },
    bbPlatform: "win32",
    probe: null,
    job: null,
    report: null,
    ...over,
  });

  test("is an error when its last probe failed, and loading while it is first asked", () => {
    expect(phaseOf(facts({ probeError: "predator did not answer in 90 seconds" }))).toBe("error");
    expect(phaseOf(facts({ probeError: null }))).toBe("loading");
  });
});
