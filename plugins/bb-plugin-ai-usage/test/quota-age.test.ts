// A quota's age is worked out at render time from when it was read, and says which
// machine it came from when that machine is offline.
import { describe, expect, test } from "bun:test";
import demoTeam from "../demo/team.json" with { type: "json" };
import { offlineSuffix, quotaAge } from "../src/format";
import { readReport, type Quota } from "../src/report";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const quota = (over: Partial<Quota>): Quota => ({ observed_at: "2026-11-10T09:00:00Z", age_seconds: 42, stale: true, device: "krech@predator", windows: [], ...over });

describe("quotaAge", () => {
  test("counts from the time the quota was read, to now", () => {
    expect(quotaAge(quota({}), NOW)).toBe(3 * 3600);
  });

  test("moves with now, so a re-render shows a larger age", () => {
    const q = quota({});
    expect(quotaAge(q, NOW + 30_000)).toBe(3 * 3600 + 30);
  });

  test("falls back to the report's age when the read time does not parse", () => {
    expect(quotaAge(quota({ observed_at: "" }), NOW)).toBe(42);
    expect(quotaAge(quota({ observed_at: "not a time" }), NOW)).toBe(42);
  });

  test("is never negative for a read time after now", () => {
    expect(quotaAge(quota({ observed_at: "2026-11-10T13:00:00Z" }), NOW)).toBe(0);
  });
});

describe("offlineSuffix", () => {
  const report = () => readReport(structuredClone(demoTeam));

  test("names the machine when its entry is old, by its name", () => {
    const r = report();
    const leo = r.team.devices.find((d) => d.name === "leo@leo-air")!;
    expect(leo.old).toBe(true);
    expect(offlineSuffix(r, quota({ device: "leo@leo-air" }))).toBe(" · leo-air offline");
  });

  test("matches the host part of user@host to a device name", () => {
    const r = report();
    expect(offlineSuffix(r, quota({ device: "someone@leo-air" }))).toBe(" · leo-air offline");
  });

  test("is empty when the machine is online", () => {
    const r = report();
    expect(offlineSuffix(r, quota({ device: "mira@mira-mbp" }))).toBe("");
  });

  test("is empty when no device matches or the quota has no device", () => {
    const r = report();
    expect(offlineSuffix(r, quota({ device: "nobody@nowhere" }))).toBe("");
    expect(offlineSuffix(r, quota({ device: null }))).toBe("");
  });
});
