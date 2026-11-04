// The matrix header names the provider and adds the account only when two
// columns share one; Cursor gets a column from its extras reading; and Gemini is
// not a subscription of its own, so its sign-in files add no tile.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import demoTeam from "../demo/team.json" with { type: "json" };
import { matrixView, tokensM } from "../src/format";
import { machineInMatrix, mergeMeasured } from "../src/local-providers";
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
