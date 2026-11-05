// The Devices × subscriptions cells that Burn has already counted.
// ai-usage's weighted burn is a different number; it is not added on top.
// Cursor is not filled here: its cells come from composer rows.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MatrixCell, Report, Usage } from "./report.js";
import { machineInMatrix } from "./local-providers.js";

const require = createRequire(import.meta.url);

/**
 * Burn's thread provider, then the matrix column it belongs in.
 * `tokens` rows and a log's utcDays become cells. A non-pending `counted` row
 * does too: its input, output, cache, and reasoning sit on the record. The
 * dollar estimate Burn stores for that text is not a token count.
 */
const COLUMN_OF: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "acp-github-copilot-cli": "copilot",
  "acp-cursor": "cursor",
  "acp-antigravity": "antigravity",
  gemini: "gemini",
  "acp-gemini": "gemini",
  "gemini-cli": "gemini",
  "google-gemini": "gemini",
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

/** Every Copilot seat, including acp-github-copilot-<key>, shares the one Copilot column. */
function columnOf(providerId: string): string | null {
  if (providerId.startsWith("acp-github-copilot-")) return "copilot";
  const known = COLUMN_OF[providerId];
  if (known !== undefined) return known;
  if (providerId.toLowerCase().includes("gemini")) return "gemini";
  if (providerId.startsWith("acp-")) return providerId.slice(4);
  return providerId === "" ? null : providerId;
}

function copilotColumn(provider: string): boolean {
  return provider === "copilot" || provider.startsWith("copilot#");
}

/** The totals key of a matrix column. Copilot seats share one key. */
function columnKey(column: { provider: string }): string {
  return copilotColumn(column.provider) ? "copilot" : column.provider;
}

function bucket(totals: Map<string, Usage>, hostId: string, providerId: string): Usage | null {
  const column = columnOf(providerId);
  // Cursor's counted text is the latest prompt, not the bill. Composer rows replace it.
  if (column === null || column === "cursor" || hostId === "") return null;
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
              CASE WHEN json_extract(record, '$.kind') = 'counted'
                   THEN json_extract(record, '$.input')
                   ELSE json_extract(record, '$.tokens.input') END AS input,
              CASE WHEN json_extract(record, '$.kind') = 'counted'
                   THEN json_extract(record, '$.output')
                   ELSE json_extract(record, '$.tokens.output') END AS output,
              CASE WHEN json_extract(record, '$.kind') = 'counted'
                   THEN json_extract(record, '$.cacheRead')
                   ELSE json_extract(record, '$.tokens.cacheRead') END AS cache_read,
              CASE WHEN json_extract(record, '$.kind') = 'counted'
                   THEN json_extract(record, '$.cacheWrite')
                   ELSE json_extract(record, '$.tokens.cacheWrite') END AS cache_write,
              CASE WHEN json_extract(record, '$.kind') = 'counted'
                   THEN json_extract(record, '$.reasoning')
                   ELSE json_extract(record, '$.tokens.reasoning') END AS reasoning
       FROM usage_records
       WHERE json_extract(record, '$.kind') = 'tokens'
          OR (json_extract(record, '$.kind') = 'counted'
              AND IFNULL(json_extract(record, '$.pending'), 0) NOT IN (1, 'true', '1'))`,
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
    if (provider === "" || providers.includes(provider) || columns.some((column) => columnKey(column) === provider)) continue;
    providers.push(provider);
  }
  for (const key of providers) {
    const hash = key.indexOf("#");
    const provider = hash === -1 ? key : key.slice(0, hash);
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

/** A machine BB knows: its id and its name. */
export interface HostName {
  id: string;
  name: string;
}

/** The host names BB keeps in bb.db, for machines the host list does not show. */
function readHostNames(dataDir: string): HostName[] {
  const bb = openDb(path.join(dataDir, "bb.db"));
  if (bb === null) return [];
  try {
    return bb
      .all("SELECT id, name FROM hosts")
      .map((row) => ({ id: String(row.id ?? ""), name: String(row.name ?? "") }))
      .filter((host) => host.id !== "" && host.name !== "");
  } catch {
    return [];
  } finally {
    bb.close();
  }
}

/** The host part of a device label such as user@host, lower-cased. */
function hostPart(device: string): string {
  const label = device.toLowerCase();
  const at = label.lastIndexOf("@");
  return at === -1 ? label : label.slice(at + 1);
}

/**
 * A row whose device_id is not a BB machine id is matched to the machine by
 * its host name, then given that id, so the burn of that machine fills it.
 */
function matchRowsByName(report: Report, names: HostName[]): void {
  const ids = new Set(names.map((host) => host.id));
  for (const row of report.team.matrix.rows) {
    if (ids.has(row.device_id)) continue;
    const match = names.find((host) => host.name.toLowerCase() === hostPart(row.device));
    if (match !== undefined) row.device_id = match.id;
  }
}

/**
 * A machine Burn counted gets a row even when it has no row yet, so its
 * tokens are not dropped. Rows are added through the same name logic as the
 * connected machines, so a row already named for the host is reused.
 */
function addRowsForCounted(report: Report, totals: Map<string, Usage>, names: HostName[]): void {
  const counted = new Set<string>();
  for (const [key, usage] of totals) {
    if (positive(usage)) counted.add(key.split("\0")[0] ?? "");
  }
  for (const hostId of counted) {
    if (report.team.matrix.rows.some((row) => row.device_id === hostId)) continue;
    const host = names.find((item) => item.id === hostId);
    if (host === undefined) continue;
    machineInMatrix(report, host.name, "", host.id);
  }
}

/**
 * Writes Burn's five-kind token sums into the matching machine cells. A cell
 * Burn did not count is left as it was, and a value replaces the cell, so a
 * second run gives the same numbers. `hosts` is every machine BB knows,
 * including ones that are offline.
 */
export function fillMatrixFromBurn(report: Report, dataDir: string, now: number, hosts: HostName[]): void {
  const totals = readTotals(dataDir, now);
  const names = [...hosts];
  for (const known of readHostNames(dataDir)) {
    if (!names.some((host) => host.id === known.id)) names.push(known);
  }
  matchRowsByName(report, names);
  ensureTokenColumns(report, totals);
  addRowsForCounted(report, totals, names);
  const columns = report.team.matrix.columns;
  const filled = new Set<number>();
  for (const row of report.team.matrix.rows) {
    const used = new Set<string>();
    let touched = false;
    columns.forEach((column, index) => {
      const key = columnKey(column);
      if (used.has(key)) return;
      const usage = totals.get(`${row.device_id}\0${key}`);
      if (usage === undefined || !positive(usage)) return;
      const cell = row.cells[index];
      if (cell === undefined) return;
      used.add(key);
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
  mergeCopilotColumns(report);
}

/**
 * One Copilot column. Cells on the same device row are added, and a dash
 * (zero) plus a number is that number. The kept column is the first.
 */
export function mergeCopilotColumns(report: Report): void {
  const columns = report.team.matrix.columns;
  const indexes: number[] = [];
  columns.forEach((column, index) => {
    if (copilotColumn(column.provider)) indexes.push(index);
  });
  if (indexes.length <= 1) return;
  const keep = indexes[0]!;
  const drop = new Set(indexes.slice(1));
  for (const row of report.team.matrix.rows) {
    const usage = empty();
    for (const index of indexes) {
      const part = cellShown(row.cells[index]);
      usage.today += part.today;
      usage["7d"] += part["7d"];
      usage["30d"] += part["30d"];
      usage["90d"] += part["90d"];
    }
    while (row.cells.length < columns.length) row.cells.push(blankCell());
    const cell = row.cells[keep] ?? blankCell();
    cell.usage = usage;
    cell.burn = null;
    cell.burn_share = null;
    row.cells[keep] = cell;
    row.cells = row.cells.filter((_, index) => !drop.has(index));
    row.usage = sumUsage(row.cells.map((item) => cellShown(item)));
    row.burn = null;
    row.burn_share = null;
  }
  const kept = columns[keep];
  if (kept !== undefined) {
    kept.provider = "copilot";
    kept.burn = null;
  }
  report.team.matrix.columns = columns.filter((_, index) => !drop.has(index));
  const index = report.team.matrix.columns.findIndex((column) => column.provider === "copilot");
  const column = report.team.matrix.columns[index];
  if (column === undefined) return;
  column.usage = sumUsage(report.team.matrix.rows.map((row) => cellShown(row.cells[index])));
  column.burn = null;
}
