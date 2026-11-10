// The fleet view: Burn's token counts land in the machine rows (matched by
// name when the id differs, and for machines that are offline), a stale
// snapshot is marked with its time without a second account, and a report
// read on the server adds no logins of its own.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import demoTeam from "../demo/team.json" with { type: "json" };
import { fillMatrixFromBurn } from "../src/burn-matrix";
import { machineInMatrix, mergeMeasured } from "../src/local-providers";
import { readReport, type Report, type TeamAccount } from "../src/report";
import { readTaken } from "../src/take";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): void }; close(): void };
};

const NOW = Date.parse("2026-11-04T12:00:00Z");
const TODAY = Date.parse("2026-11-04T09:00:00Z");

/** A data folder with BB's host and thread tables and Burn's token records. */
function dataFolder(
  hosts: [string, string][],
  threads: [string, string, string][],
  tokens: [string, number][],
  counted: { threadId: string; record: Record<string, unknown> }[] = [],
): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-usage-fleet-"));
  mkdirSync(path.join(dir, "plugins", "burn"), { recursive: true });
  const bb = new DatabaseSync(path.join(dir, "bb.db"));
  bb.exec(`
    CREATE TABLE hosts (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE environments (id TEXT PRIMARY KEY, host_id TEXT);
    CREATE TABLE threads (id TEXT PRIMARY KEY, provider_id TEXT, environment_id TEXT);
    CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT);`);
  for (const [id, name] of hosts) bb.prepare("INSERT INTO hosts VALUES (?, ?)").run(id, name);
  for (const [threadId, provider, hostId] of threads) {
    const env = `env-${hostId}`;
    bb.prepare("INSERT OR IGNORE INTO environments VALUES (?, ?)").run(env, hostId);
    bb.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(threadId, provider, env);
  }
  bb.close();
  const burn = new DatabaseSync(path.join(dir, "plugins", "burn", "data.db"));
  burn.exec("CREATE TABLE usage_records (thread_id TEXT, record TEXT);");
  for (const [threadId, input] of tokens) {
    burn.prepare("INSERT INTO usage_records VALUES (?, ?)").run(threadId, JSON.stringify({ kind: "tokens", at: TODAY, tokens: { input } }));
  }
  for (const row of counted) {
    burn.prepare("INSERT INTO usage_records VALUES (?, ?)").run(row.threadId, JSON.stringify(row.record));
  }
  burn.close();
  return dir;
}

function fresh(): Report {
  const report = readReport(structuredClone(demoTeam));
  report.team.matrix.rows = [];
  return report;
}

const columnOf = (report: Report, provider: string) => report.team.matrix.columns.findIndex((c) => c.provider === provider);

describe("burn fill", () => {
  const predator = { id: "host_predator", name: "predator" };
  const cpc = { id: "host_cpc", name: "CPC" };

  test("matches a row to its machine by name when the id differs, then fills its cell", () => {
    const dir = dataFolder([[predator.id, predator.name]], [["t1", "claude-code", predator.id]], [["t1", 500_000_000]]);
    try {
      const report = fresh();
      machineInMatrix(report, predator.name, "leo", "stale-id");
      fillMatrixFromBurn(report, dir, NOW, [predator]);
      const row = report.team.matrix.rows.find((r) => r.device.endsWith("@predator"))!;
      expect(row.device_id).toBe(predator.id);
      expect(row.cells[columnOf(report, "claude")]!.usage["7d"]).toBe(500_000_000);
      expect(report.team.matrix.rows.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("adds a row for a machine with burn that has no row, offline or not in the host list", () => {
    const dir = dataFolder(
      [[predator.id, predator.name], [cpc.id, cpc.name]],
      [["t1", "claude-code", predator.id], ["t2", "acp-github-copilot-cli", cpc.id]],
      [["t1", 1_000], ["t2", 104_000_000]],
    );
    try {
      const report = fresh();
      // Only predator is in the list the caller passes; CPC is found in bb.db and has no row yet.
      fillMatrixFromBurn(report, dir, NOW, [predator]);
      const cpcRow = report.team.matrix.rows.find((r) => r.device_id === cpc.id);
      expect(cpcRow).toBeDefined();
      expect(cpcRow!.cells[columnOf(report, "copilot")]!.usage["7d"]).toBe(104_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a counted cursor row does not fill the matrix", () => {
    const dir = dataFolder(
      [[predator.id, predator.name]],
      [
        ["t1", "acp-cursor", predator.id],
        ["t2", "acp-cursor", predator.id],
      ],
      [],
      [
        {
          threadId: "t1",
          record: { kind: "counted", at: TODAY, input: 100, output: 40, cacheRead: 5, cacheWrite: 3, reasoning: 2 },
        },
        { threadId: "t1", record: { kind: "counted", pending: true, at: TODAY, input: 9_000_000, output: 1, reasoning: 1 } },
        { threadId: "t2", record: { kind: "counted", at: TODAY, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      ],
    );
    try {
      const report = fresh();
      machineInMatrix(report, predator.name, "leo", predator.id);
      fillMatrixFromBurn(report, dir, NOW, [predator]);
      expect(report.team.matrix.columns.some((c) => c.provider === "cursor")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copilot seats from different accounts sum into one column", () => {
    const dir = dataFolder(
      [[predator.id, predator.name]],
      [
        ["t1", "acp-github-copilot-cli", predator.id],
        ["t2", "acp-github-copilot-ssgia", predator.id],
      ],
      [
        ["t1", 800_000],
        ["t2", 5_000],
      ],
    );
    try {
      const report = fresh();
      machineInMatrix(report, predator.name, "leo", predator.id);
      fillMatrixFromBurn(report, dir, NOW, [predator]);
      const copilot = report.team.matrix.columns.filter((c) => c.provider === "copilot");
      expect(copilot).toHaveLength(1);
      expect(report.team.matrix.rows[0]!.cells[columnOf(report, "copilot")]!.usage["7d"]).toBe(805_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a counted gemini or antigravity row fills that column", () => {
    const dir = dataFolder(
      [[predator.id, predator.name]],
      [
        ["t1", "gemini", predator.id],
        ["t2", "acp-antigravity", predator.id],
      ],
      [],
      [
        { threadId: "t1", record: { kind: "counted", at: TODAY, input: 80, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
        { threadId: "t2", record: { kind: "counted", at: TODAY, input: 10, output: 5, cacheRead: 1, cacheWrite: 0, reasoning: 4 } },
      ],
    );
    try {
      const report = fresh();
      machineInMatrix(report, predator.name, "leo", predator.id);
      fillMatrixFromBurn(report, dir, NOW, [predator]);
      const row = report.team.matrix.rows[0]!;
      expect(row.cells[columnOf(report, "gemini")]!.usage["7d"]).toBe(100);
      expect(row.cells[columnOf(report, "antigravity")]!.usage["7d"]).toBe(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("running it twice gives the same report", () => {
    const dir = dataFolder([[predator.id, predator.name]], [["t1", "claude-code", predator.id]], [["t1", 42_000_000]]);
    try {
      const report = fresh();
      machineInMatrix(report, predator.name, "leo", "stale-id");
      fillMatrixFromBurn(report, dir, NOW, [predator]);
      const once = JSON.stringify(report);
      fillMatrixFromBurn(report, dir, NOW, [predator]);
      expect(JSON.stringify(report)).toBe(once);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshot merge", () => {
  const reading = {
    hostName: "AM-J630L261YG",
    user: "snapshot-user",
    providers: [{ provider: "claude", name: "snapshot-login@am", plan: "Max", windows: [{ name: "7d", percentUsed: 40, resetsAt: null }] }],
  };

  test("an earlier reading is marked old with its time and adds no second account", () => {
    const report = readReport(structuredClone(demoTeam));
    const at = Date.now() - 3 * 3_600_000;
    mergeMeasured(report, reading, { measuredAt: at });
    mergeMeasured(report, reading, { measuredAt: at });
    const device = report.team.devices.find((d) => d.name === "AM-J630L261YG")!;
    expect(device.old).toBe(true);
    expect(device.collected_at).toBe(new Date(at).toISOString());
    expect(device.note).toContain("last seen");
    expect(device.age_seconds).toBeGreaterThan(3 * 3600 - 5);
    const accounts = report.team.providers.find((p) => p.provider === "claude")!.accounts.filter((a) => a.name === "snapshot-login@am");
    expect(accounts.length).toBe(1);
  });

  test("a live reading is not marked old", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, reading);
    const device = report.team.devices.find((d) => d.name === "AM-J630L261YG")!;
    expect(device.old).toBe(false);
    expect(device.note).toBe("snapshot-user");
  });
});

describe("the report read on the server", () => {
  test("keeps exactly the providers ai-usage printed; no local logins are added", () => {
    const raw = structuredClone(demoTeam);
    const providers = (r: Report) => r.team.providers.map((p) => p.provider).sort();
    expect(providers(readTaken(raw))).toEqual(providers(readReport(structuredClone(raw))));
  });
});

describe("the freshest reading wins", () => {
  const LOGIN = "fresh-login";
  const reading = (percent: number, hostName = "fresh-host") => ({
    hostName,
    user: "fresh-user",
    providers: [{ provider: "freshplan", name: LOGIN, plan: "Fresh", windows: [{ name: "fresh", percentUsed: percent, resetsAt: null }] }],
  });
  const login = (report: Report): TeamAccount => {
    const accounts = report.team.providers.find((p) => p.provider === "freshplan")!.accounts.filter((a) => a.name === LOGIN);
    expect(accounts.length).toBe(1);
    return accounts[0]!;
  };
  const percent = (report: Report) => login(report).quota!.windows[0]!.percent;

  afterEach(() => setSystemTime());

  test("a stale reading never overwrites a newer one", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, reading(10));
    mergeMeasured(report, reading(50, "old-host"), { measuredAt: Date.now() - 3 * 3_600_000 });
    expect(percent(report)).toBe(10);
    expect(login(report).quota!.stale).toBe(false);
    expect(login(report).devices).toContain("old-host");
  });

  test("a reading replaces an existing quota whose observed_at is missing", () => {
    const report = readReport(structuredClone(demoTeam));
    mergeMeasured(report, reading(10));
    login(report).quota!.observed_at = "";
    mergeMeasured(report, reading(25));
    expect(percent(report)).toBe(25);
  });

  test("on a tie, a live reading beats a stale one", () => {
    const report = readReport(structuredClone(demoTeam));
    const at = Date.parse("2026-11-04T12:00:00Z");
    mergeMeasured(report, reading(60, "snap-host"), { measuredAt: at });
    expect(login(report).quota!.stale).toBe(true);
    setSystemTime(new Date(at));
    mergeMeasured(report, reading(20));
    expect(percent(report)).toBe(20);
    expect(login(report).quota!.stale).toBe(false);
  });

  test("two snapshots merged in either order give the newer one", () => {
    const newer = Date.now() - 1 * 3_600_000;
    const older = Date.now() - 3 * 3_600_000;
    const forward = readReport(structuredClone(demoTeam));
    mergeMeasured(forward, reading(30, "snap-a"), { measuredAt: newer });
    mergeMeasured(forward, reading(70, "snap-b"), { measuredAt: older });
    const backward = readReport(structuredClone(demoTeam));
    mergeMeasured(backward, reading(70, "snap-b"), { measuredAt: older });
    mergeMeasured(backward, reading(30, "snap-a"), { measuredAt: newer });
    expect(percent(forward)).toBe(30);
    expect(percent(backward)).toBe(30);
    expect(login(backward).quota!.observed_at).toBe(new Date(newer).toISOString());
  });
});
