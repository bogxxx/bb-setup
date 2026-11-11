import { describe, expect, test } from "bun:test";
import { copilotPercentUsed } from "../src/local-providers";
import { copilotFromReading, GH_COPILOT_JQ } from "../src/measure";

// A token-billed business seat: premium_interactions has no quota flag, and remaining is 0.
const tokenBilled = {
  login: "bohdan-krechko-akerbp",
  copilot_plan: "business",
  quota_reset_date_utc: "2026-12-01T00:00:00Z",
  quota_snapshots: {
    premium_interactions: { entitlement: 100000, has_quota: false, unlimited: false, percent_remaining: 0, remaining: 0 },
    chat: { entitlement: 0, has_quota: true, unlimited: true, percent_remaining: 100, remaining: 0 },
    completions: { entitlement: 0, has_quota: true, unlimited: true, percent_remaining: 100, remaining: 0 },
  },
};

describe("the Copilot quota snapshot rule", () => {
  test("a snapshot without has_quota and with remaining 0 is fully used", () => {
    expect(copilotPercentUsed(tokenBilled.quota_snapshots.premium_interactions)).toBe(100);
  });

  test("a snapshot with quota left reads as used", () => {
    expect(copilotPercentUsed({ entitlement: 300, has_quota: true, unlimited: false, percent_remaining: 80 })).toBe(20);
  });

  test("an unlimited snapshot is dropped", () => {
    expect(copilotPercentUsed(tokenBilled.quota_snapshots.chat)).toBeNull();
    expect(copilotPercentUsed({ unlimited: true, has_quota: false, entitlement: 100, percent_remaining: 0 })).toBeNull();
  });

  test("a snapshot with no entitlement or no numeric remaining is dropped", () => {
    expect(copilotPercentUsed({ entitlement: 0, has_quota: false, percent_remaining: 0 })).toBeNull();
    expect(copilotPercentUsed({ entitlement: 100, has_quota: false })).toBeNull();
    expect(copilotPercentUsed(undefined)).toBeNull();
  });
});

describe("the gh filter on a token-billed seat", () => {
  const jq = Bun.which("jq");

  test.skipIf(jq === null)("keeps the window at 100% used and drops the unlimited ones", () => {
    const run = Bun.spawnSync([jq!, "-c", GH_COPILOT_JQ], {
      stdin: new TextEncoder().encode(JSON.stringify(tokenBilled)),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const reading = copilotFromReading(run.stdout.toString());
    expect(reading).toEqual({
      provider: "copilot",
      name: "bohdan-krechko-akerbp",
      plan: "business",
      windows: [{ name: "premium_interactions", percentUsed: 100, resetsAt: "2026-12-01T00:00:00Z" }],
    });
  });
});
