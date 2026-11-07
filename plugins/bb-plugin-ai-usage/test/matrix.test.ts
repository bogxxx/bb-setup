// The matrix header names the provider and adds the account only when two
// columns share one; Cursor gets a column from its extras reading; and Gemini is
// not a subscription of its own, so its sign-in files add no tile.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import demoTeam from "../demo/team.json" with { type: "json" };
import { mergeCopilotColumns } from "../src/burn-matrix";
import { applyCursorUsage, composerCharge, composerUsage } from "../src/cursor-usage";
import { matrixView, percentLeft, tokensM } from "../src/format";
import { gravityWindows, machineInMatrix, mergeMeasured } from "../src/local-providers";
import type { MatrixCell, MatrixColumn, Usage } from "../src/report";
import { otherLogins } from "../src/measure";
import { readReport, type Report } from "../src/report";

function fresh(): Report {
  const report = readReport(structuredClone(demoTeam));
  report.team.matrix.rows = [];
  return report;
}

describe("matrix header", () => {
  test("names the provider, and adds the account only where two columns share a provider", () => {
    const m = matrixView(readReport(structuredClone(demoTeam)), "7d");
    const codex = m.columns.filter((c) => c.provider === "codex");
    expect(codex.length).toBeGreaterThan(1);
    for (const column of codex) {
      expect(column.title).toBe("Codex");
      expect(column.account).not.toBeNull();
    }
    const grok = m.columns.find((c) => c.provider === "grok")!;
    expect(grok.title).toBe("Grok");
    expect(grok.account).toBeNull();
  });
});

describe("cursor column", () => {
  test("a Cursor login from extras gets its own column, and its cells show the en dash", () => {
    const report = fresh();
    machineInMatrix(report, "CPC-bohda-22UVG", "bohdkrec", "host_cpc");
    mergeMeasured(report, {
      hostName: "CPC-bohda-22UVG",
      user: "bohdkrec",
      providers: [{ provider: "cursor", name: "Pro+", plan: "Pro+", windows: [{ name: "Auto", percentUsed: 30, resetsAt: null }] }],
    });
    const m = matrixView(report, "7d");
    const column = m.columns.findIndex((c) => c.provider === "cursor");
    expect(column).toBeGreaterThan(-1);
    expect(m.columns[column]!.title).toBe("Cursor");
    expect(m.columns[column]!.account).toBeNull();
    const row = m.rows.find((r) => r.id === "host_cpc")!;
    expect(row.cells[column]!.text).toBe(tokensM(0));
  });
});

describe("argon quota", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const reset = "2026-11-06T00:00:00Z";
  const healthy = [
    { modelId: "gemini-2.5-pro", remainingFraction: 1, resetTime: reset },
    { modelId: "claude-sonnet-5-5", remainingFraction: 1, resetTime: reset },
    { modelId: "gpt-oss-120b-medium", remainingFraction: 1, resetTime: reset },
  ];

  test("an argon bucket with remainingFraction 0 is its own meter at 0% left, and the models keep theirs", () => {
    for (const modelId of ["gemini-4-argon", "argon"]) {
      const windows = gravityWindows([...healthy, { modelId, remainingFraction: 0, resetTime: "2026-11-01T00:00:00Z" }], now);
      const argon = windows.find((window) => window.name.endsWith("Argon"));
      expect(argon).toBeDefined();
      expect(percentLeft(argon!)).toBe(0);
      expect(windows.filter((window) => window.name !== argon!.name).map((window) => percentLeft(window))).toEqual([100, 100, 100]);
      expect(windows.find((window) => window.name === "Gemini, Claude, GPT")).toBeUndefined();
      expect(windows[0]).toEqual(argon!);
    }
  });

  test("a past reset or an exhausted mark is its own Argon window at 0% left", () => {
    const past = gravityWindows([...healthy, { modelId: "gemini-4-argon", remainingFraction: 1, resetTime: "2026-11-01T00:00:00Z" }], now);
    const marked = gravityWindows([...healthy, { modelId: "gemini-4-argon", remainingFraction: 1, resetTime: reset, exhausted: true }], now);
    for (const windows of [past, marked]) {
      expect(percentLeft(windows.find((window) => window.name.endsWith("Argon"))!)).toBe(0);
      expect(windows).toHaveLength(4);
    }
  });
});

describe("gemini", () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "ai-usage-home-"));
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), JSON.stringify({ access_token: "made-up", refresh_token: "made-up" }));
    writeFileSync(path.join(home, ".gemini", "gemini-credentials.json"), "{}");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterAll(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  });

  test("Gemini sign-in files add no Gemini subscription", () => {
    expect(otherLogins([]).some((item) => item.provider === "gemini")).toBe(false);
  });
});

function zeroUsage(): Usage {
  return { today: 0, "7d": 0, "30d": 0, "90d": 0 };
}

function zeroCell(): MatrixCell {
  return { usage: zeroUsage(), burn: null, share: { today: null, "7d": null, "30d": null, "90d": null }, burn_share: null };
}

function copilotColumn(name: string): MatrixColumn {
  return { provider: "copilot", label: null, name, no_quota: false, state: "ok", percent: null, usage: zeroUsage(), burn: null };
}

describe("copilot columns", () => {
  test("two seats become one column, and a dash plus a number is that number", () => {
    const report = fresh();
    report.team.matrix.columns.push(copilotColumn("bohdan-krechko-akerbp"), copilotColumn("bohdan-krechko_ssgia"));
    const cells = report.team.matrix.columns.map(() => zeroCell());
    const first = report.team.matrix.columns.findIndex((c) => c.name === "bohdan-krechko-akerbp");
    const second = report.team.matrix.columns.findIndex((c) => c.name === "bohdan-krechko_ssgia");
    cells[first] = { ...zeroCell(), usage: { today: 0, "7d": 805_000, "30d": 21_000_000, "90d": 169_000_000 } };
    cells[second] = { ...zeroCell(), usage: { today: 1_000, "7d": 0, "30d": 5, "90d": 5 } };
    report.team.matrix.rows.push({
      device: "krech@predator",
      device_id: "host_predator",
      cells,
      usage: zeroUsage(),
      burn: null,
      share: { today: null, "7d": null, "30d": null, "90d": null },
      burn_share: null,
      burn_estimated: false,
    });
    mergeCopilotColumns(report);
    expect(report.team.matrix.columns.filter((c) => c.provider === "copilot")).toHaveLength(1);
    const view = matrixView(report, "7d");
    const shown = view.columns.filter((c) => c.provider === "copilot");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Copilot");
    expect(shown[0]!.account).toBeNull();
    const index = view.columns.findIndex((c) => c.provider === "copilot");
    expect(view.rows[0]!.cells[index]!.text).toBe("805K");
    expect(view.rows[0]!.cells[index]!.tokens).toBe(805_000);
    expect(report.team.matrix.rows[0]!.cells[index]!.usage).toEqual({
      today: 1_000,
      "7d": 805_000,
      "30d": 21_000_005,
      "90d": 169_000_005,
    });
  });
});

describe("cursor composer usage", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const conversation = 25;

  test("a 1000-token stable prefix and 3 turns is cache read 2000 and fresh input 1000 plus conversation", () => {
    const input = {
      categories: [
        { id: "system_prompt", estimatedTokens: 1000 },
        { id: "conversation", estimatedTokens: conversation },
      ],
      headers: [{}, {}, {}],
    };
    const charge = composerCharge(input);
    expect(charge.cacheRead).toBe(2000);
    expect(charge.fresh).toBe(1000 + conversation);
    expect(charge.output).toBe(0);
    // No timestamp: the whole total stays in every window instead of being dropped.
    const total = charge.fresh + charge.cacheRead;
    expect(composerUsage(input, now)).toEqual({ today: total, "7d": total, "30d": total, "90d": total });
  });

  test("a composer timestamp outside the window stays out of that window", () => {
    const usage = composerUsage(
      {
        categories: [
          { id: "system_prompt", estimatedTokens: 1000 },
          { id: "conversation", estimatedTokens: 0 },
        ],
        headers: [
          { createdAt: "2026-08-15T00:00:00Z" },
          { createdAt: "2026-08-15T01:00:00Z" },
          { createdAt: "2026-08-15T02:00:00Z" },
        ],
        createdAt: "2026-08-15T00:00:00Z",
      },
      now,
    );
    expect(usage.today).toBe(0);
    expect(usage["7d"]).toBe(0);
    expect(usage["30d"]).toBe(0);
    expect(usage["90d"]).toBe(3000);
  });

  test("composer usage replaces the cursor cell burn had counted", () => {
    const report = fresh();
    machineInMatrix(report, "predator", "krech", "host_predator");
    const burned = { today: 40_275, "7d": 1_435_134, "30d": 1_435_134, "90d": 1_435_134 };
    report.team.matrix.columns.push({
      provider: "cursor",
      label: null,
      name: "Pro+",
      no_quota: false,
      state: "ok",
      percent: null,
      usage: { ...burned },
      burn: null,
    });
    const row = report.team.matrix.rows[0]!;
    row.cells.push({ ...zeroCell(), usage: { ...burned } });
    row.usage = { ...burned };
    const composer = { today: 0, "7d": 255_094, "30d": 401_924, "90d": 107_686_883 };
    applyCursorUsage(report, "host_predator", composer);
    const index = report.team.matrix.columns.findIndex((c) => c.provider === "cursor");
    expect(report.team.matrix.columns.filter((c) => c.provider === "cursor")).toHaveLength(1);
    expect(row.cells[index]!.usage).toEqual(composer);
    expect(row.cells[index]!.burn).toBeNull();
    expect(row.usage).toEqual(composer);
    expect(report.team.matrix.columns[index]!.usage).toEqual(composer);
  });
});
