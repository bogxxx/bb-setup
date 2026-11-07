// A refresh never blanks or shrinks a loaded page: the page's report changes only
// when a complete merged report is ready, a machine whose extras fail keeps its
// last readings, and a failed refresh leaves the loaded report on the page.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import demoTeam from "../demo/team.json" with { type: "json" };
import { shownPhase } from "../src/phase";
import { mergeMachine } from "../src/take";
import { contentHash, nextShown, reportForClient, type Shown } from "../src/shown";
import { readReport, type Report } from "../src/report";

function fresh(): Report {
  const report = readReport(structuredClone(demoTeam));
  report.team.matrix.rows = [];
  return report;
}

const EMPTY: Shown = { report: null, hash: null, reportAt: null };

describe("the shown report", () => {
  test("generated_at alone is no change", () => {
    const a = fresh();
    const b = structuredClone(a);
    b.generated_at = "2030-01-01T00:00:00Z";
    expect(contentHash(a)).toBe(contentHash(b));
    const c = structuredClone(a);
    c.team.devices[0]!.name = "renamed";
    expect(contentHash(c)).not.toBe(contentHash(a));
  });

  test("a complete merge with the same content keeps the shown state as it was", () => {
    const first = nextShown(EMPTY, fresh(), 1000);
    expect(first.reportAt).toBe(1000);
    const again = nextShown(first, structuredClone(first.report!), 2000);
    expect(again).toBe(first);
  });

  test("while a refresh is pending, a client gets the previous complete report, never a partial one", () => {
    const shown = nextShown(EMPTY, fresh(), 1000);
    // A local read arrives and is kept aside; no merge has finished, so the shown state is untouched.
    const partial = fresh();
    partial.team.devices = [];
    expect(reportForClient(shown, shown.hash)).toBeNull();
    expect(reportForClient(shown, "an older hash")).toBe(shown.report);
    expect(reportForClient(shown, "an older hash")!.team.devices.length).toBeGreaterThan(0);
    expect(partial.team.devices.length).toBe(0);
  });

  test("the same readings merged at different wall-clock times are the same report", () => {
    const providers = [{ provider: "cursor", name: "Pro+", plan: "Pro+", windows: [{ name: "Auto", percentUsed: 30, resetsAt: null }] }];
    const machine = { id: "host_cpc", name: "CPC-bohda" };
    const snapAt = Date.parse("2026-11-07T10:00:00Z");
    const hashAt = (now: number, live: boolean) => {
      setSystemTime(new Date(now));
      const r = fresh();
      mergeMachine(r, machine, live ? { hostName: "cpc-bohda", user: "bohdkrec", providers } : null, { at: snapAt, alias: "cpc-bohda", user: "bohdkrec", providers }, "");
      return contentHash(r);
    };
    expect(hashAt(Date.parse("2026-11-07T10:05:00Z"), true)).toBe(hashAt(Date.parse("2026-11-07T11:40:00Z"), true));
    expect(hashAt(Date.parse("2026-11-07T10:05:00Z"), false)).toBe(hashAt(Date.parse("2026-11-07T11:40:00Z"), false));
    // Real content still shows: a changed percent is a new report.
    const moved = fresh();
    mergeMachine(moved, machine, null, { at: snapAt, alias: "cpc-bohda", user: "bohdkrec", providers: [{ ...providers[0]!, windows: [{ name: "Auto", percentUsed: 31, resetsAt: null }] }] }, "");
    expect(contentHash(moved)).not.toBe(hashAt(Date.parse("2026-11-07T10:05:00Z"), false));
  });

  test("a read that restamps only its times and ages is the same report", () => {
    const a = fresh();
    const b = structuredClone(a);
    b.generated_at = "2030-01-01T00:00:00Z";
    for (const d of b.team.devices) d.age_seconds += 600;
    for (const p of b.team.providers) for (const acc of p.accounts) if (acc.quota !== null) acc.quota.age_seconds += 600;
    expect(contentHash(a)).toBe(contentHash(b));
  });

  afterEach(() => setSystemTime());

  test("a client with no hash gets nothing before the first load and the report after it", () => {
    expect(reportForClient(EMPTY, null)).toBeNull();
    expect(reportForClient(nextShown(EMPTY, fresh(), 1), null)).not.toBeNull();
  });
});

describe("a machine's readings in the report", () => {
  const providers = [{ provider: "cursor", name: "Pro+", plan: "Pro+", windows: [{ name: "Auto", percentUsed: 30, resetsAt: null }] }];
  const machine = { id: "host_cpc", name: "CPC-bohda" };
  const cursorPercents = (report: Report) =>
    (report.team.providers.find((p) => p.provider === "cursor")?.accounts ?? []).flatMap((a) => (a.quota?.windows ?? []).map((w) => w.percent));

  test("when the extras call failed, the machine keeps its last snapshot, marked as old", () => {
    const report = fresh();
    mergeMachine(report, machine, null, { at: Date.now() - 3_600_000, alias: "cpc-bohda", user: "bohdkrec", providers }, "");
    expect(cursorPercents(report)).toEqual([30]);
    expect(report.team.devices.some((d) => d.old)).toBe(true);
    expect(report.team.matrix.rows.some((row) => row.device_id === "host_cpc")).toBe(true);
  });

  test("a live reading replaces the snapshot", () => {
    const report = fresh();
    const live = { hostName: "cpc-bohda", user: "bohdkrec", providers: [{ ...providers[0]!, windows: [{ name: "Auto", percentUsed: 60, resetsAt: null }] }] };
    mergeMachine(report, machine, live, { at: Date.now(), alias: "cpc-bohda", user: "bohdkrec", providers }, "");
    expect(cursorPercents(report)).toEqual([60]);
  });

  test("the probe's user fills in only when neither reading has one", () => {
    const report = fresh();
    mergeMachine(report, machine, null, null, "probe-user");
    expect(report.team.matrix.rows.find((row) => row.device_id === "host_cpc")).toBeDefined();
    const withSnap = fresh();
    mergeMachine(withSnap, machine, null, { at: Date.now(), alias: "", user: "snap-user", providers: [] }, "probe-user");
    expect(withSnap.team.matrix.rows.length).toBe(1);
  });
});

describe("a failed refresh", () => {
  test("a loaded report stays on the page; the placeholders are for a first load only", () => {
    for (const phase of ["error", "loading", "needs-first-run"] as const) {
      expect(shownPhase(phase, true)).toBe("ready");
      expect(shownPhase(phase, false)).toBe(phase);
    }
  });

  test("a schema this plugin does not read, or an ai-usage that is gone, still replaces the page", () => {
    expect(shownPhase("schema-mismatch", true)).toBe("schema-mismatch");
    expect(shownPhase("absent", true)).toBe("absent");
    expect(shownPhase("offline", true)).toBe("offline");
    expect(shownPhase("ready", true)).toBe("ready");
  });
});
