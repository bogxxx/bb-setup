// The extras call settles inside its budget even when a provider stalls, and
// Copilot is read on every system: Windows from its credential store, macOS and
// Linux through gh.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copilotFromReading, copilotReader, GH_COPILOT_JQ, measureUsage } from "../src/measure";

describe("measureUsage budget", () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, fetch: globalThis.fetch };
  let home: string;

  beforeAll(() => {
    // A Codex login, so the Codex request runs; its fetch never answers unless the budget ends it.
    home = mkdtempSync(path.join(os.tmpdir(), "ai-usage-budget-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "made-up", account_id: "made-up", id_token: "" } }),
    );
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = saved.fetch;
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  });

  test("a stalled provider does not hold the call past its budget", async () => {
    const started = Date.now();
    const usage = await measureUsage(1500);
    const took = Date.now() - started;
    expect(took).toBeLessThan(4000);
    expect(usage.providers.some((p) => p.provider === "codex")).toBe(false);
  }, 20_000);

  test("with no budget left, no step starts", async () => {
    const started = Date.now();
    const usage = await measureUsage(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(usage.providers.some((p) => p.provider === "codex")).toBe(false);
  });
});

describe("Copilot on every system", () => {
  test("Windows reads its credential store; macOS and Linux ask gh", () => {
    expect(copilotReader("win32")).toBe("windows");
    expect(copilotReader("darwin")).toBe("gh");
    expect(copilotReader("linux")).toBe("gh");
  });

  test("a gh reading becomes the Copilot login with its windows", () => {
    const reading = JSON.stringify({
      plan: "business",
      login: "example-login",
      windows: [{ name: "premium_interactions", percentUsed: 20, resetsAt: "2026-12-01T00:00:00Z" }],
    });
    expect(copilotFromReading(reading)).toEqual({
      provider: "copilot",
      name: "example-login",
      plan: "business",
      windows: [{ name: "premium_interactions", percentUsed: 20, resetsAt: "2026-12-01T00:00:00Z" }],
    });
  });

  test("a gh reading without a login or a window is no reading", () => {
    expect(copilotFromReading(JSON.stringify({ plan: "business", login: "", windows: [{ name: "x", percentUsed: 1, resetsAt: null }] }))).toBeNull();
    expect(copilotFromReading(JSON.stringify({ plan: "business", login: "someone", windows: [] }))).toBeNull();
    expect(copilotFromReading("not json")).toBeNull();
  });

  test("the gh filter names the fields the reader needs", () => {
    for (const field of ["copilot_plan", "login", "quota_snapshots", "percent_remaining", "quota_reset_date_utc"]) {
      expect(GH_COPILOT_JQ).toContain(field);
    }
  });
});
