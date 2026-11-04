// Machines often share one OS user. A reading is matched to its machine by host name
// only, and a stale reading never overwrites a quota read after it was taken.
import { describe, expect, test } from "bun:test";
import demoTeam from "../demo/team.json" with { type: "json" };
import { mergeMeasured } from "../src/local-providers";
import { readReport, type Report, type TeamAccount } from "../src/report";

const SHARED_USER = "shared-user";

function accountNamed(report: Report, provider: string, name: string): TeamAccount {
  const account = report.team.providers.find((p) => p.provider === provider)?.accounts.find((a) => a.name === name);
  if (account === undefined) throw new Error(`no ${provider} account ${name}`);
  return account;
}

describe("two machines under one OS user", () => {
  test("a stale snapshot of one machine does not change the live quota of the other", () => {
    const report = readReport(structuredClone(demoTeam));

    // Machine A reports live now.
    mergeMeasured(report, {
      hostName: "host-a",
      user: SHARED_USER,
      providers: [{ provider: "copilot", name: "login-a", plan: "business", windows: [{ name: "premium", percentUsed: 10, resetsAt: null }] }],
    });

    // Machine B is offline; its snapshot is from three hours ago and shows another reading of login-a.
    const measuredAt = Date.now() - 3 * 3_600_000;
    mergeMeasured(
      report,
      {
        hostName: "host-b",
        user: SHARED_USER,
        providers: [
          { provider: "copilot", name: "login-a", plan: "business", windows: [{ name: "premium", percentUsed: 50, resetsAt: null }] },
          { provider: "copilot", name: "login-b", plan: "business", windows: [{ name: "premium", percentUsed: 30, resetsAt: null }] },
        ],
      },
      { measuredAt },
    );

    // Each reading has its own device; the shared OS user did not join them.
    const hostA = report.team.devices.find((d) => d.name === "host-a")!;
    const hostB = report.team.devices.find((d) => d.name === "host-b")!;
    expect(hostA).toBeDefined();
    expect(hostB).toBeDefined();
    expect(hostA.old).toBe(false);
    expect(hostA.note).toBe(SHARED_USER);
    expect(hostB.old).toBe(true);

    // Machine A's live login keeps its live quota, and is not shown as stale.
    const liveA = accountNamed(report, "copilot", "login-a");
    expect(liveA.quota!.windows[0]!.percent).toBe(10);
    expect(liveA.quota!.stale).toBe(false);

    // Machine B's login that A does not have shows as stale, with its age.
    const staleB = accountNamed(report, "copilot", "login-b");
    expect(staleB.quota!.stale).toBe(true);
    expect(staleB.quota!.observed_at).toBe(new Date(measuredAt).toISOString());
    expect(staleB.quota!.age_seconds).toBeGreaterThan(3 * 3600 - 5);
  });

  test("a snapshot of a machine the live reading already covers does not replace it", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, {
      hostName: "host-c",
      user: SHARED_USER,
      providers: [{ provider: "cursor", name: "live-seat", plan: "Pro", windows: [{ name: "auto", percentUsed: 5, resetsAt: null }] }],
    });
    mergeMeasured(
      report,
      {
        hostName: "host-c",
        user: SHARED_USER,
        providers: [{ provider: "cursor", name: "live-seat", plan: "Pro", windows: [{ name: "auto", percentUsed: 90, resetsAt: null }] }],
      },
      { measuredAt: Date.now() - 60 * 60_000 },
    );
    const seat = accountNamed(report, "cursor", "live-seat");
    expect(seat.quota!.windows[0]!.percent).toBe(5);
    expect(seat.quota!.stale).toBe(false);
  });
});
