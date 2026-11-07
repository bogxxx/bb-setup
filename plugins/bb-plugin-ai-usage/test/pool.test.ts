import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyPoolExtraUsage, poolStatusSchema, type PoolStatus } from "../src/pool";
import { readReport, type Report } from "../src/report";

const report = (): Report => readReport(JSON.parse(readFileSync(path.join(import.meta.dir, "../demo/team.json"), "utf8")));
const pool = (accounts: unknown[]): PoolStatus["accounts"] => poolStatusSchema.parse({ accounts }).accounts;
const allowed = { status: "allowed", observedAt: "2026-11-07T10:00:00Z" };

function claudeAccounts(r: Report) {
  return r.team.providers.find((p) => p.provider === "claude")!.accounts;
}

describe("applyPoolExtraUsage", () => {
  test("a Claude account takes the extra usage of the pool account with its email", () => {
    const r = applyPoolExtraUsage(report(), pool([{ provider: "claude", email: "mira@studio.dev", extraUsage: allowed }]));
    const [mira, leo, unknown] = claudeAccounts(r);
    expect(mira!.extra_usage).toEqual({ status: "allowed", observed_at: "2026-11-07T10:00:00Z" });
    expect(leo!.extra_usage).toBeNull();
    expect(unknown!.extra_usage).toBeNull();
  });

  test("the match ignores case", () => {
    const r = applyPoolExtraUsage(report(), pool([{ provider: "claude", email: "Mira@Studio.DEV", extraUsage: { status: "rejected", observedAt: null } }]));
    expect(claudeAccounts(r)[0]!.extra_usage).toEqual({ status: "rejected", observed_at: null });
  });

  test("an account with no pool account of its email keeps null", () => {
    const r = applyPoolExtraUsage(report(), pool([{ provider: "claude", email: "someone@else.dev", extraUsage: allowed }]));
    expect(claudeAccounts(r).every((a) => a.extra_usage === null)).toBe(true);
  });

  test("two pool accounts with the same email are ambiguous and skipped", () => {
    const r = applyPoolExtraUsage(report(), pool([
      { provider: "claude", email: "mira@studio.dev", extraUsage: allowed },
      { provider: "claude", email: "mira@studio.dev", extraUsage: { status: "rejected", observedAt: null } },
    ]));
    expect(claudeAccounts(r)[0]!.extra_usage).toBeNull();
  });

  test("a pool account with no extra usage reading sets nothing", () => {
    const r = applyPoolExtraUsage(report(), pool([{ provider: "claude", email: "mira@studio.dev", extraUsage: null }]));
    expect(claudeAccounts(r)[0]!.extra_usage).toBeNull();
  });

  test("pool accounts of another provider are ignored", () => {
    const r = applyPoolExtraUsage(report(), pool([{ provider: "codex", email: "mira@studio.dev", extraUsage: allowed }]));
    expect(claudeAccounts(r)[0]!.extra_usage).toBeNull();
    const codex = r.team.providers.find((p) => p.provider === "codex")!.accounts;
    expect(codex.every((a) => a.extra_usage === null)).toBe(true);
  });

  test("the report it is given is not changed", () => {
    const before = report();
    applyPoolExtraUsage(before, pool([{ provider: "claude", email: "mira@studio.dev", extraUsage: allowed }]));
    expect(claudeAccounts(before)[0]!.extra_usage).toBeNull();
  });

  test("the pool's epoch milliseconds read as the report's ISO time", () => {
    const r = applyPoolExtraUsage(report(), pool([{ provider: "claude", email: "mira@studio.dev", extraUsage: { status: "rejected", observedAt: 1794076422930, source: "header" } }]));
    expect(claudeAccounts(r)[0]!.extra_usage).toEqual({ status: "rejected", observed_at: "2026-11-07T18:33:42.930Z" });
  });

  test("a pool account without an email or with extra fields still reads", () => {
    const accounts = pool([{ provider: "claude", extraUsage: allowed, plan: "max" }, { provider: "claude", email: "leo@studio.dev", extraUsage: { status: "allowed" } }]);
    const r = applyPoolExtraUsage(report(), accounts);
    expect(claudeAccounts(r)[1]!.extra_usage).toEqual({ status: "allowed", observed_at: null });
  });
});
