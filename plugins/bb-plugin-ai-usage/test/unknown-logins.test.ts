// A Codex sign-in whose login could not be read is an account named `unknown` with no quota. On the
// server it folds into the one known login of its provider; with none or several, it is dropped and
// no login is guessed. Its sessions, usage and matrix cells are kept with the login that absorbs them.
import { describe, expect, test } from "bun:test";
import demoTeam from "../demo/team.json" with { type: "json" };
import { foldUnknownLogins } from "../src/local-providers";
import { readReport, type MatrixCell, type Report, type TeamAccount } from "../src/report";

const usage = (sevenDay: number) => ({ today: 0, "7d": sevenDay, "30d": sevenDay, "90d": sevenDay });
const cell = (sevenDay: number): MatrixCell => ({ usage: usage(sevenDay), burn: null, share: { today: null, "7d": null, "30d": null, "90d": null }, burn_share: null });

function account(name: string, over: Partial<TeamAccount> = {}): TeamAccount {
  return {
    label: name,
    name,
    alias: null,
    subscription: true,
    current: true,
    devices: ["device-a"],
    plan: null,
    state: "ok",
    quota: null,
    sessions: 0,
    usage: usage(0),
    burn: null,
    users: 1,
    busiest: null,
    last_active_at: null,
    no_reading: null,
    extra_usage: null,
    ...over,
  };
}

function codexReport(accounts: TeamAccount[], columns: string[]): Report {
  const report = readReport(structuredClone(demoTeam));
  report.team.providers = [{ provider: "codex", accounts }];
  report.team.matrix.columns = columns.map((name) => ({ provider: "codex", label: null, name, no_quota: false, state: "ok", percent: null, usage: usage(0), burn: null }));
  report.team.matrix.rows = [
    { device: "mac", device_id: "d1", cells: columns.map((_, i) => cell(i === 0 ? 100 : 388_705)), usage: usage(388_805), burn: null, share: { today: null, "7d": null, "30d": null, "90d": null }, burn_share: null, burn_estimated: false },
  ];
  return report;
}

describe("the unknown Codex sign-in", () => {
  test("with one known login, it folds into that login's card, numbers, devices and matrix column", () => {
    const report = codexReport(
      [account("krechko.bogdan", { devices: ["mac"], sessions: 3, usage: usage(100), users: 1, last_active_at: "2026-11-08T00:00:00Z" }), account("unknown", { devices: ["bohdkrec"], sessions: 8, usage: usage(388_705), users: 1, last_active_at: "2026-11-09T00:00:00Z" })],
      ["krechko.bogdan", "unknown"],
    );
    foldUnknownLogins(report);
    const codex = report.team.providers.find((p) => p.provider === "codex")!;
    expect(codex.accounts.map((a) => a.name)).toEqual(["krechko.bogdan"]);
    const login = codex.accounts[0]!;
    expect(login.sessions).toBe(11);
    expect(login.usage["7d"]).toBe(388_805);
    expect(login.devices).toEqual(["mac", "bohdkrec"]);
    expect(login.users).toBe(2);
    expect(login.last_active_at).toBe("2026-11-09T00:00:00Z");
    expect(report.team.matrix.columns.map((c) => c.name)).toEqual(["krechko.bogdan"]);
    expect(report.team.matrix.rows[0]!.cells).toHaveLength(1);
    expect(report.team.matrix.rows[0]!.cells[0]!.usage["7d"]).toBe(388_805);
    expect(report.team.matrix.rows[0]!.usage["7d"]).toBe(388_805);
  });

  test("with two known logins, the placeholder card goes and the logins are unchanged", () => {
    const logins = [account("first@example.com", { sessions: 2 }), account("second@example.com", { sessions: 5 })];
    const report = codexReport([...logins, account("unknown", { sessions: 8 })], ["first@example.com", "second@example.com", "unknown"]);
    foldUnknownLogins(report);
    const codex = report.team.providers.find((p) => p.provider === "codex")!;
    expect(codex.accounts.map((a) => [a.name, a.sessions])).toEqual([
      ["first@example.com", 2],
      ["second@example.com", 5],
    ]);
    expect(report.team.matrix.columns.map((c) => c.name)).toEqual(["first@example.com", "second@example.com", "unknown"]);
  });

  test("with no known login, the provider group with only the placeholder is removed", () => {
    const report = codexReport([account("unknown", { sessions: 8 })], ["unknown"]);
    foldUnknownLogins(report);
    expect(report.team.providers.find((p) => p.provider === "codex")).toBeUndefined();
  });

  test("an account named unknown that has a quota is a real login and stays", () => {
    const quota = { observed_at: "2026-11-09T00:00:00Z", age_seconds: 0, stale: false, device: null, windows: [] };
    const report = codexReport([account("krechko.bogdan"), account("unknown", { quota })], ["krechko.bogdan", "unknown"]);
    foldUnknownLogins(report);
    const codex = report.team.providers.find((p) => p.provider === "codex")!;
    expect(codex.accounts.map((a) => a.name)).toEqual(["krechko.bogdan", "unknown"]);
  });
});
