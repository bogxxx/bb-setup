// A login's windows are merged by name across its readings: the fresher reading's numbers win, and a window
// only the other reading reports is kept with its own stale mark. A stale reading's window whose reset has
// passed is dropped; a live reading keeps every window it reports.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import demoTeam from "../demo/team.json" with { type: "json" };
import { mergeMachine } from "../src/take";
import { mergeMeasured } from "../src/local-providers";
import { readReport, type Report, type TeamAccount, type Window } from "../src/report";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const THREE_HOURS = 3 * 3_600_000;
const FUTURE = "2026-11-14T00:00:00Z";
const PAST = "2026-11-09T00:00:00Z";
const LOGIN = "login-x";

const window = (name: string, percentUsed: number, resetsAt: string | null) => ({ name, percentUsed, resetsAt });
const five = (percent: number) => ["a", "b", "c", "d", "e"].map((n) => window(n, percent, FUTURE));
const login = (report: Report): TeamAccount => {
  const accounts = report.team.providers.find((p) => p.provider === "claude")!.accounts.filter((a) => a.name === LOGIN);
  expect(accounts.length).toBe(1);
  return accounts[0]!;
};
const byName = (windows: Window[]) => Object.fromEntries(windows.map((w) => [w.name, w]));

afterEach(() => setSystemTime());

describe("windows merged across readings", () => {
  test("a live reading and an older snapshot with extra windows give one card with every window", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-old", user: "u", providers: [{ provider: "claude", name: LOGIN, plan: "Max", windows: [...five(90), window("f", 5, FUTURE), window("g", 5, FUTURE), window("h", 5, FUTURE)] }] }, { measuredAt: NOW - THREE_HOURS });
    mergeMeasured(report, { hostName: "host-live", user: "u", providers: [{ provider: "claude", name: LOGIN, plan: "Max", windows: five(10) }] });
    const windows = login(report).quota!.windows;
    expect(windows).toHaveLength(8);
    const named = byName(windows);
    for (const n of ["a", "b", "c", "d", "e"]) expect([named[n]!.percent, named[n]!.stale]).toEqual([10, false]);
    for (const n of ["f", "g", "h"]) expect([named[n]!.percent, named[n]!.stale]).toEqual([5, true]);
    expect(windows.filter((w) => w.main)).toHaveLength(1);
    expect(login(report).quota!.stale).toBe(false);
  });

  test("the same two readings merged in the other order give the same windows", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-live", user: "u", providers: [{ provider: "claude", name: LOGIN, plan: "Max", windows: five(10) }] });
    mergeMeasured(report, { hostName: "host-old", user: "u", providers: [{ provider: "claude", name: LOGIN, plan: "Max", windows: [...five(90), window("f", 5, FUTURE), window("g", 5, FUTURE), window("h", 5, FUTURE)] }] }, { measuredAt: NOW - THREE_HOURS });
    const named = byName(login(report).quota!.windows);
    expect(Object.keys(named).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect([named.a!.percent, named.a!.stale, named.f!.stale]).toEqual([10, false, true]);
  });

  test("an older snapshot's extra window whose reset has passed is not added", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-live", user: "u", providers: [{ provider: "claude", name: LOGIN, plan: "Max", windows: five(10) }] });
    mergeMeasured(report, { hostName: "host-old", user: "u", providers: [{ provider: "claude", name: LOGIN, plan: "Max", windows: [...five(90), window("f", 5, PAST)] }] }, { measuredAt: NOW - THREE_HOURS });
    expect(login(report).quota!.windows.map((w) => w.name)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("expired stale windows", () => {
  const CURSOR = "cursor-login@example.com";
  const cursorStale = (windows: { name: string; percentUsed: number; resetsAt: string | null }[]) => ({
    hostName: "host-off",
    user: "u",
    providers: [{ provider: "cursor", name: CURSOR, plan: "Pro+", windows }],
  });

  test("a stale snapshot whose windows have all reset adds no card", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, cursorStale([window("Monthly", 40, PAST)]), { measuredAt: NOW - THREE_HOURS });
    expect(report.team.providers.find((p) => p.provider === "cursor")?.accounts.some((a) => a.name === CURSOR) ?? false).toBe(false);
  });

  test("one window past its reset is dropped and the first window left is main", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, cursorStale([window("Monthly", 40, PAST), window("Weekly", 20, FUTURE)]), { measuredAt: NOW - THREE_HOURS });
    const account = report.team.providers.find((p) => p.provider === "cursor")!.accounts.find((a) => a.name === CURSOR)!;
    expect(account.quota!.windows.map((w) => [w.name, w.main, w.stale])).toEqual([["Weekly", true, true]]);
  });

  test("a live reading keeps a window whose reset has passed", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, cursorStale([window("Monthly", 40, PAST)]));
    const account = report.team.providers.find((p) => p.provider === "cursor")!.accounts.find((a) => a.name === CURSOR)!;
    expect(account.quota!.windows.map((w) => w.name)).toEqual(["Monthly"]);
  });

  test("a stale login that never had windows still shows its signed-in card", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, cursorStale([]), { measuredAt: NOW - THREE_HOURS });
    const account = report.team.providers.find((p) => p.provider === "cursor")!.accounts.find((a) => a.name === CURSOR)!;
    expect(account.no_reading).toBe("Signed in. No limit reading yet.");
  });

  test("an all-reset stale snapshot of a login already shown adds its device and keeps the quota", () => {
    setSystemTime(new Date(NOW));
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-live", user: "u", providers: [{ provider: "cursor", name: CURSOR, plan: "Pro+", windows: [window("Monthly", 20, FUTURE)] }] });
    mergeMeasured(report, cursorStale([window("Monthly", 99, PAST)]), { measuredAt: NOW - THREE_HOURS });
    const account = report.team.providers.find((p) => p.provider === "cursor")!.accounts.find((a) => a.name === CURSOR)!;
    expect(account.quota!.windows.map((w) => [w.percent, w.stale])).toEqual([[20, false]]);
    expect(account.devices).toContain("host-off");
  });
});

describe("profile Copilot seats", () => {
  const seat = (name: string, percent: number, profile?: string) => ({ provider: "copilot", name, plan: "business", windows: [window("premium", percent, FUTURE)], ...(profile === undefined ? {} : { profile }) });
  const live = { hostName: "host-seat", user: "u", providers: [seat("default-login", 10), seat("bohdan-krechko_ssgia", 55, "sopra")] };

  test("a bb Copilot seat is hidden by default and shown with its key when the setting is on", () => {
    const hidden = readReport(structuredClone(demoTeam));
    mergeMachine(hidden, { id: "m1", name: "host-seat" }, live, null, "u");
    const names = (r: Report) => r.team.providers.find((p) => p.provider === "copilot")!.accounts.map((a) => a.name);
    expect(names(hidden)).toContain("default-login");
    expect(names(hidden)).not.toContain("bohdan-krechko_ssgia");

    const shown = readReport(structuredClone(demoTeam));
    mergeMachine(shown, { id: "m1", name: "host-seat" }, live, null, "u", { showProfileSeats: true });
    const seatCard = shown.team.providers.find((p) => p.provider === "copilot")!.accounts.find((a) => a.name === "bohdan-krechko_ssgia")!;
    expect(seatCard.label).toBe("bohdan-krechko_ssgia (gh-sopra)");
  });

  test("a stored snapshot with a seat is filtered the same way", () => {
    const snap = { at: Date.now() - THREE_HOURS, alias: "host-seat", user: "u", providers: [seat("default-login", 10), seat("bohdan-krechko_ssgia", 55, "sopra")] };
    const report = readReport(structuredClone(demoTeam));
    mergeMachine(report, { id: "m1", name: "host-seat" }, null, snap, "u");
    const names = report.team.providers.find((p) => p.provider === "copilot")!.accounts.map((a) => a.name);
    expect(names).toContain("default-login");
    expect(names).not.toContain("bohdan-krechko_ssgia");
  });
});
