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

describe("a bare login and its email are one account", () => {
  const rows = (report: Report, provider: string) => report.team.providers.find((p) => p.provider === provider)!.accounts.filter((a) => a.subscription);
  const claude = (name: string, percentUsed: number) => ({ provider: "claude", name, plan: "Max", windows: [{ name: "login-7d", percentUsed, resetsAt: null }] });

  test("a live bare login and a stale email with its local part give one row, the live reading", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-a", user: SHARED_USER, providers: [claude("krechko.bogdan", 10)] });
    mergeMeasured(report, { hostName: "host-b", user: SHARED_USER, providers: [claude("krechko.bogdan@gmail.com", 50)] }, { measuredAt: Date.now() - 3_600_000 });
    const matched = rows(report, "claude").filter((a) => a.name.startsWith("krechko.bogdan"));
    expect(matched.length).toBe(1);
    expect(matched[0]!.name).toBe("krechko.bogdan");
    expect(matched[0]!.quota!.windows[0]!.percent).toBe(10);
    expect(matched[0]!.devices).toEqual(expect.arrayContaining(["host-a", "host-b"]));
  });

  test("the same two in the other order give one row, still the live reading", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-b", user: SHARED_USER, providers: [claude("krechko.bogdan@gmail.com", 50)] }, { measuredAt: Date.now() - 3_600_000 });
    mergeMeasured(report, { hostName: "host-a", user: SHARED_USER, providers: [claude("krechko.bogdan", 10)] });
    const matched = rows(report, "claude").filter((a) => a.name.startsWith("krechko.bogdan"));
    expect(matched.length).toBe(1);
    expect(matched[0]!.quota!.windows[0]!.percent).toBe(10);
  });

  test("two different email addresses stay two rows", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-a", user: SHARED_USER, providers: [claude("a@x.com", 10)] });
    mergeMeasured(report, { hostName: "host-b", user: SHARED_USER, providers: [claude("a@y.com", 50)] });
    const matched = rows(report, "claude").filter((a) => a.name.startsWith("a@"));
    expect(matched.map((a) => a.name).sort()).toEqual(["a@x.com", "a@y.com"]);
  });

  test("a user@host device name is not a login, so it does not merge into the bare login", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-a", user: SHARED_USER, providers: [claude("krech", 10)] });
    mergeMeasured(report, { hostName: "host-b", user: SHARED_USER, providers: [claude("krech@predator", 50)] }, { measuredAt: Date.now() - 3_600_000 });
    const matched = rows(report, "claude").filter((a) => a.name.startsWith("krech"));
    expect(matched.map((a) => a.name).sort()).toEqual(["krech", "krech@predator"]);
  });

  test("a hostname with the same quota as a login still folds into it", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, { hostName: "host-a", user: SHARED_USER, providers: [claude("krechko.bogdan@gmail.com", 10)] });
    mergeMeasured(report, { hostName: "host-b", user: SHARED_USER, providers: [claude("host-b-machine", 10)] }, { measuredAt: Date.now() - 3_600_000 });
    const matched = rows(report, "claude").filter((a) => a.name.startsWith("krechko.bogdan") || a.name === "host-b-machine");
    expect(matched.map((a) => a.name)).toEqual(["krechko.bogdan@gmail.com"]);
  });
});
