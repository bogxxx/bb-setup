// The plugin reads every report the repository's demo tooling makes, a
// report as an earlier release printed it, and a kind of attention it does
// not know, as the menu bar app's checks do.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { attentionWords, cardWindows, extraUsageWords, left, limitingWindows, matrixView, shown, tokenLabel, tokensM, windowLabel } from "../src/format";
import { readReport, SchemaError } from "../src/report";

// The repository demo reports sit beside the plugin only in the monorepo. The vendored copy
// bundles the example team, so the other reports are tested where docs/ exists.
const REPO_DEMO = path.join(import.meta.dir, "../../docs/demo");
const HAS_REPO_DEMO = existsSync(REPO_DEMO);
const demo = (name: string) => JSON.parse(readFileSync(path.join(HAS_REPO_DEMO ? REPO_DEMO : path.join(import.meta.dir, "../demo"), name), "utf8"));

/** Removes the fields ai-usage added within schema 4, as a report of v0.3.4 has none of them. */
const ADDED = new Set([
  "health", "method", "command", "limits", "today_local", "folders", "subject", "text", "note", "pooled", "name", "cost",
  "burn", "burn_share", "window_burn", "burn_days", "fresh", "basis", "pace", "stopped", "estimated_reason", "no_reading",
]);
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !ADDED.has(k)).map(([k, x]) => [k, strip(x)]));
}

describe.each(HAS_REPO_DEMO ? ["team.json", "solo.json", "homebrew.json"] : ["team.json"])("%s", (name) => {
  const raw = demo(name);
  const r = readReport(raw);

  test("reads every part the panel shows", () => {
    expect(r.team.devices.length).toBe(raw.team.devices.length);
    expect(r.attention.length).toBe(raw.attention.length);
    expect(r.collector.health.length).toBe(3);
    expect(r.cost).not.toBeNull();
    expect(r.team.devices.every((d) => Array.isArray(d.pooled))).toBe(true);
  });

  test("shows the report's words as given", () => {
    for (const [i, a] of r.attention.entries()) {
      expect(attentionWords(a)).toEqual({ subject: raw.attention[i].subject, text: raw.attention[i].text });
    }
  });

  test("the matrix's totals are the report's", () => {
    const m = matrixView(r, "7d");
    expect(m.rows.length).toBe(raw.team.matrix.rows.length);
    raw.team.matrix.columns.forEach((c: { burn: Record<string, number> }, i: number) => expect(m.columns[i]!.total).toBe(tokensM(c.burn["7d"]!)));
    expect(tokenLabel(r)).toBe("weighted tokens");
  });
});

test.skipIf(!HAS_REPO_DEMO)("a total with an estimated row in it is an estimate, as the app's", () => {
  const r = readReport(demo("team.json"));
  const estimated = r.team.matrix.rows.filter((row) => row.burn_estimated).map((row) => row.device);
  expect(estimated.length).toBeGreaterThan(0);
  const m = matrixView(r, "7d");
  for (const row of m.rows) expect(row.total.startsWith("~")).toBe(estimated.includes(row.device) && row.total !== "~–");
  expect(m.total.startsWith("~")).toBe(true);
  const sure = readReport(demo("solo.json"));
  expect(matrixView(sure, "7d").total.startsWith("~")).toBe(false);
});

test.skipIf(!HAS_REPO_DEMO)("the example team the plugin bundles is the repository's", () => {
  expect(readFileSync(path.join(import.meta.dir, "../demo/team.json"), "utf8")).toBe(readFileSync(path.join(import.meta.dir, "../../docs/demo/team.json"), "utf8"));
});

test("a report of an earlier release reads its missing fields as the app does", () => {
  const r = readReport(strip(demo("team.json")));
  expect(r.collector.health).toEqual([]);
  expect(r.collector.update.method).toBe("self");
  expect(r.collector.update.command).toBeNull();
  expect(r.cost).toBeNull();
  expect(r.team.today_local).toBe(false);
  expect(r.team.devices.every((d) => d.name === "" && d.note === null && d.pooled.length === 0)).toBe(true);
  expect(tokenLabel(r)).toBe("tokens, including input, output, cache, and reasoning");
  const row = r.team.matrix.rows[0]!;
  expect(shown(row)).toEqual(row.usage);
  // Without `limits`, only the main window limits an account.
  for (const p of r.team.providers) for (const a of p.accounts) for (const w of limitingWindows(a)) expect(w.main || !w.limits).toBe(true);
  // An entry that is not worded says its devices and its message.
  const old = r.attention.find((a) => a.kind === "old")!;
  expect(attentionWords(old).subject).toBe((old.devices ?? []).join(", "));
});

test("a kind it does not know is shown with the report's words", () => {
  const raw = demo("team.json");
  raw.attention.push({ kind: "someday", subject: "leo@leo-air", text: "a kind from a later release" });
  const r = readReport(raw);
  expect(attentionWords(r.attention.at(-1)!)).toEqual({ subject: "leo@leo-air", text: "a kind from a later release" });
});

test("another schema is refused", () => {
  expect(() => readReport({ schema_version: 5 })).toThrow(SchemaError);
  expect(() => readReport({ schema_version: 3, generated_at: "2026-09-24T13:40:00Z" })).toThrow(SchemaError);
});

test("a Claude card shows the session, the weekly limit, and each family window the binary reports", () => {
  const raw = demo("team.json");
  const mira = raw.team.providers.find((p: { provider: string }) => p.provider === "claude").accounts[0];
  mira.quota.windows.push({ ...mira.quota.windows[1], name: "7d Fable", main: false, limits: false });
  const r = readReport(raw);
  const a = r.team.providers.find((p) => p.provider === "claude")!.accounts[0]!;
  const windows = cardWindows("claude", a);
  expect(windows.map((w) => w.name)).toEqual(["5h", "7d", "7d Fable"]);
  expect(windows.map(windowLabel)).toEqual(["5-hour", "Weekly · all models", "Weekly · Fable"]);
});

test("a Claude card lists its families in name order after the weekly limit", () => {
  const raw = demo("team.json");
  const mira = raw.team.providers.find((p: { provider: string }) => p.provider === "claude").accounts[0];
  mira.quota.windows.push({ ...mira.quota.windows[1], name: "7d Sonnet", main: false, limits: false }, { ...mira.quota.windows[1], name: "7d Opus", main: false, limits: false });
  const a = readReport(raw).team.providers.find((p) => p.provider === "claude")!.accounts[0]!;
  expect(cardWindows("claude", a).map((w) => w.name)).toEqual(["5h", "7d", "7d Opus", "7d Sonnet"]);
});

test("other providers' cards show what limits them, as before", () => {
  const r = readReport(demo("team.json"));
  for (const p of r.team.providers.filter((x) => x.provider !== "claude")) {
    for (const a of p.accounts) expect(cardWindows(p.provider, a)).toEqual(limitingWindows(a));
  }
});

test("an unknown Claude window is kept, and its label is the report's name", () => {
  const raw = demo("team.json");
  const mira = raw.team.providers.find((p: { provider: string }) => p.provider === "claude").accounts[0];
  mira.quota.windows.push({ ...mira.quota.windows[1], name: "1d Burst", main: false, limits: false, reset: true, minutes: 1440 });
  const a = readReport(raw).team.providers.find((p) => p.provider === "claude")!.accounts[0]!;
  const burst = cardWindows("claude", a).find((w) => w.name === "1d Burst")!;
  expect(left(burst)).toBe("?");
  expect(windowLabel(burst)).toBe("1d Burst");
});

test("window labels name the session, the weekly limit, and a family", () => {
  const w = (name: string) => ({ name, percent: 0, resets_at: null, minutes: null, main: false, limits: false, stale: false, reset: false, unread: null, state: "ok", forecast: null });
  expect(windowLabel(w("5h"))).toBe("5-hour");
  expect(windowLabel(w("7d"))).toBe("Weekly · all models");
  expect(windowLabel(w("7d Opus"))).toBe("Weekly · Opus");
  expect(windowLabel(w("Claude Opus 5.5"))).toBe("Claude Opus 5.5");
});

test("extra usage is read when the report has it, and null when it does not", () => {
  const raw = demo("team.json");
  const old = readReport(raw).team.providers[0]!.accounts[0]!;
  expect(old.extra_usage).toBeNull();
  raw.team.providers[0].accounts[0].extra_usage = { status: "allowed", observed_at: "2026-11-07T10:00:00Z" };
  expect(readReport(raw).team.providers[0]!.accounts[0]!.extra_usage).toEqual({ status: "allowed", observed_at: "2026-11-07T10:00:00Z" });
  expect(extraUsageWords({ status: "rejected", observed_at: null })).toBe("Extra usage: off or spent");
  expect(extraUsageWords({ status: "allowed", observed_at: null })).toBe("Extra usage: available");
  expect(extraUsageWords({ status: "other", observed_at: null })).toBeNull();
});
