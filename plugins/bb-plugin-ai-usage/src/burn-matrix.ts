// The Devices × subscriptions cells that Burn has already counted.
// ai-usage's weighted burn is a different number; it is not added on top.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MatrixCell, Report, Usage } from "./report.js";

const require = createRequire(import.meta.url);

/**
 * Burn's thread provider, then the matrix column it belongs in.
 * `counted` ledger rows are estimates and never reach this map: only `tokens`
 * and a log's utcDays become cells.
 */
const COLUMN_OF: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "acp-github-copilot-cli": "copilot",
  "acp-cursor": "cursor",
  "acp-antigravity": "antigravity",
};

const DAY_MS = 86_400_000;

interface Sql {
  all(sql: string, ...params: string[]): Record<string, unknown>[];
  close(): void;
}

function openDb(file: string): Sql | null {
  if (!existsSync(file)) return null;
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, opts: { readOnly: boolean }) => {
      prepare(sql: string): { all(...params: string[]): Record<string, unknown>[] };
      close(): void;
    };
  };
  const db = new DatabaseSync(file, { readOnly: true });
  return { all: (sql, ...params) => db.prepare(sql).all(...params), close: () => db.close() };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function empty(): Usage {
  return { today: 0, "7d": 0, "30d": 0, "90d": 0 };
}

function positive(u: Usage): boolean {
  return u.today > 0 || u["7d"] > 0 || u["30d"] > 0 || u["90d"] > 0;
}

function five(input: unknown, output: unknown, cacheRead: unknown, cacheWrite: unknown, reasoning: unknown): number {
  return num(input) + num(output) + num(cacheRead) + num(cacheWrite) + num(reasoning);
}

/** UTC calendar day, or null when `at` is not a time. Values below 1e12 are seconds. */
function utcDay(at: unknown): string | null {
  const n = typeof at === "number" ? at : typeof at === "string" && at.trim() !== "" ? Number(at) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const day = new Date(ms).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function addDay(usage: Usage, day: string, today: string, starts: { "7d": string; "30d": string; "90d": string }, tokens: number): void {
  if (tokens === 0 || day > today) return;
  if (day === today) usage.today += tokens;
  if (day >= starts["7d"]) usage["7d"] += tokens;
  if (day >= starts["30d"]) usage["30d"] += tokens;
  if (day >= starts["90d"]) usage["90d"] += tokens;
}

function cellShown(cell: MatrixCell | undefined): Usage {
  if (cell === undefined) return empty();
  return cell.burn ?? cell.usage;
}

function sumUsage(list: Usage[]): Usage {
  const out = empty();
  for (const usage of list) {
    out.today += usage.today;
    out["7d"] += usage["7d"];
    out["30d"] += usage["30d"];
    out["90d"] += usage["90d"];
  }
  return out;
}

function columnOf(providerId: string): string | null {
  const known = COLUMN_OF[providerId];
  if (known !== undefined) return known;
  if (providerId.startsWith("acp-")) return providerId.slice(4);
  return providerId === "" ? null : providerId;
}

function bucket(totals: Map<string, Usage>, hostId: string, providerId: string): Usage | null {
  const column = columnOf(providerId);
  if (column === null || hostId === "") return null;
  const id = `${hostId}\0${column}`;
  let usage = totals.get(id);
  if (usage === undefined) {
    usage = empty();
    totals.set(id, usage);
  }
  return usage;
}

function asDays(value: unknown): { day?: unknown; tokens?: Record<string, unknown> }[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as { day?: unknown; tokens?: Record<string, unknown> }[]) : [];
}

function readTotals(dataDir: string, now: number): Map<string, Usage> {
  const totals = new Map<string, Usage>();
  const bb = openDb(path.join(dataDir, "bb.db"));
  if (bb === null) return totals;
  const burn = openDb(path.join(dataDir, "plugins", "burn", "data.db"));
  try {
    const today = new Date(now).toISOString().slice(0, 10);
    const start = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    const starts = { "7d": start(7), "30d": start(30), "90d": start(90) };
    const hosts = new Map<string, { hostId: string; providerId: string }>();
    for (const row of bb.all(
      `SELECT t.id AS thread_id, t.provider_id AS provider_id, h.id AS host_id
       FROM threads t
       JOIN environments e ON e.id = t.environment_id
       JOIN hosts h ON h.id = e.host_id`,
    )) {
      hosts.set(String(row.thread_id), { hostId: String(row.host_id), providerId: String(row.provider_id) });
    }
    const logged = new Set<string>();
    for (const row of bb.all(
      `SELECT substr(key, 5) AS thread_id, json_extract(value, '$.report.utcDays') AS days
       FROM plugin_kv WHERE plugin_id = ? AND key LIKE 'log:%'`,
      "burn",
    )) {
      const threadId = String(row.thread_id);
      logged.add(threadId);
      const joined = hosts.get(threadId);
      const usage = joined === undefined ? null : bucket(totals, joined.hostId, joined.providerId);
      if (usage === null) continue;
      for (const day of asDays(row.days)) {
        if (typeof day.day !== "string") continue;
        const tokens = day.tokens;
        addDay(usage, day.day, today, starts, five(tokens?.input, tokens?.output, tokens?.cacheRead, tokens?.cacheWrite, tokens?.reasoning));
      }
    }
    if (burn === null) return totals;
    for (const row of burn.all(
      `SELECT thread_id,
              json_extract(record, '$.at') AS at,
              json_extract(record, '$.tokens.input') AS input,
              json_extract(record, '$.tokens.output') AS output,
              json_extract(record, '$.tokens.cacheRead') AS cache_read,
              json_extract(record, '$.tokens.cacheWrite') AS cache_write,
              json_extract(record, '$.tokens.reasoning') AS reasoning
       FROM usage_records WHERE json_extract(record, '$.kind') = 'tokens'`,
    )) {
      const threadId = String(row.thread_id);
      if (logged.has(threadId)) continue;
      const joined = hosts.get(threadId);
      const usage = joined === undefined ? null : bucket(totals, joined.hostId, joined.providerId);
      const day = utcDay(row.at);
      if (usage === null || day === null) continue;
      addDay(usage, day, today, starts, five(row.input, row.output, row.cache_read, row.cache_write, row.reasoning));
    }
    return totals;
  } finally {
    burn?.close();
    bb.close();
  }
}

function blankCell(): MatrixCell {
  const share = { today: null, "7d": null, "30d": null, "90d": null };
  return { usage: empty(), burn: null, share, burn_share: null };
}

/** A provider Burn actually counted gets a column. An estimate-only provider does not. */
function ensureTokenColumns(report: Report, totals: Map<string, Usage>): void {
  const columns = report.team.matrix.columns;
  const providers: string[] = [];
  for (const [key, usage] of totals) {
    if (!positive(usage)) continue;
    const provider = key.split("\0")[1] ?? "";
    if (provider === "" || providers.includes(provider) || columns.some((column) => column.provider === provider)) continue;
    providers.push(provider);
  }
  for (const provider of providers) {
    const group = report.team.providers.find((item) => item.provider === provider);
    const account = group?.accounts.find((item) => item.subscription) ?? group?.accounts[0];
    const main = account?.quota?.windows.find((window) => window.main) ?? account?.quota?.windows[0];
    columns.push({
      provider,
      label: account?.label ?? null,
      name: account?.name ?? provider,
      no_quota: false,
      state: account?.state ?? "unknown",
      percent: main?.percent ?? null,
      usage: empty(),
      burn: null,
    });
  }
  if (providers.length === 0) return;
  for (const row of report.team.matrix.rows) {
    while (row.cells.length < columns.length) row.cells.push(blankCell());
  }
}

/** Writes Burn's five-kind token sums into the matching machine cells. A cell Burn did not count is left as it was. */
export function fillMatrixFromBurn(report: Report, dataDir: string, now = Date.now()): void {
  const totals = readTotals(dataDir, now);
  ensureTokenColumns(report, totals);
  const columns = report.team.matrix.columns;
  const filled = new Set<number>();
  for (const row of report.team.matrix.rows) {
    const used = new Set<string>();
    let touched = false;
    columns.forEach((column, index) => {
      if (used.has(column.provider)) return;
      const usage = totals.get(`${row.device_id}\0${column.provider}`);
      if (usage === undefined || !positive(usage)) return;
      const cell = row.cells[index];
      if (cell === undefined) return;
      used.add(column.provider);
      cell.usage = { today: usage.today, "7d": usage["7d"], "30d": usage["30d"], "90d": usage["90d"] };
      cell.burn = null;
      cell.burn_share = null;
      touched = true;
      filled.add(index);
    });
    if (!touched) continue;
    row.usage = sumUsage(row.cells.map((cell) => cellShown(cell)));
    row.burn = null;
    row.burn_share = null;
  }
  for (const index of filled) {
    const column = columns[index];
    if (column === undefined) continue;
    column.usage = sumUsage(report.team.matrix.rows.map((row) => cellShown(row.cells[index])));
    column.burn = null;
  }
}
