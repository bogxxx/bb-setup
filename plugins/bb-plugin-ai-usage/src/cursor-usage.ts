// Cursor's matrix cells. The stable prefix is fresh input once, then a cache
// read on every later turn. Burn's counted text is not added on top.
import type { MatrixCell, MatrixColumn, Report, Usage } from "./report.js";

const DAY_MS = 86_400_000;
const PERIODS = ["today", "7d", "30d", "90d"] as const;
const STABLE = ["system_prompt", "tools", "rules", "skills", "mcp", "subagents"] as const;

export interface ComposerHeader {
  createdAt?: unknown;
  startedAtMs?: unknown;
  completedAtMs?: unknown;
}

export interface ComposerCategory {
  id?: unknown;
  estimatedTokens?: unknown;
}

/** One composer row: category token estimates and the turn headers. */
export interface ComposerInput {
  categories: ComposerCategory[];
  headers?: ComposerHeader[];
  createdAt?: unknown;
  lastUpdatedAt?: unknown;
  /** A real output total, when the row has one. Per-message token counts are not this. */
  output?: unknown;
}

export interface ComposerCharge {
  fresh: number;
  cacheRead: number;
  output: number;
  /** The stable prefix, once. Cache read is this times turns after the first. */
  stable: number;
}

export function emptyUsage(): Usage {
  return { today: 0, "7d": 0, "30d": 0, "90d": 0 };
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Epoch milliseconds, or null. Values below 1e12 are seconds. */
function msOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function categoryTokens(categories: ComposerCategory[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const category of categories) {
    if (typeof category.id !== "string" || category.id === "") continue;
    out.set(category.id, (out.get(category.id) ?? 0) + num(category.estimatedTokens));
  }
  return out;
}

/**
 * Fresh input is the stable prefix plus the conversation, once.
 * Cache read is that prefix again for every turn after the first.
 */
export function composerCharge(input: ComposerInput): ComposerCharge {
  const tokens = categoryTokens(input.categories);
  let stable = 0;
  for (const id of STABLE) stable += tokens.get(id) ?? 0;
  const conversation = (tokens.get("conversation") ?? 0) + (tokens.get("summarized_conversation") ?? 0);
  const turns = Math.max(1, input.headers?.length ?? 0);
  return {
    fresh: stable + conversation,
    cacheRead: stable * (turns - 1),
    output: num(input.output) + (tokens.get("output") ?? 0),
    stable,
  };
}

function windowOf(now: number): { today: string; starts: Record<"7d" | "30d" | "90d", string> } {
  const today = new Date(now).toISOString().slice(0, 10);
  const start = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return { today, starts: { "7d": start(7), "30d": start(30), "90d": start(90) } };
}

/** Adds `tokens` to the windows that contain `at`. No timestamp counts in every window. */
function addAt(usage: Usage, now: { today: string; starts: Record<"7d" | "30d" | "90d", string> }, at: number | null, tokens: number): void {
  if (tokens === 0) return;
  if (at === null) {
    usage.today += tokens;
    usage["7d"] += tokens;
    usage["30d"] += tokens;
    usage["90d"] += tokens;
    return;
  }
  const day = new Date(at).toISOString().slice(0, 10);
  if (day > now.today) return;
  if (day === now.today) usage.today += tokens;
  if (day >= now.starts["7d"]) usage["7d"] += tokens;
  if (day >= now.starts["30d"]) usage["30d"] += tokens;
  if (day >= now.starts["90d"]) usage["90d"] += tokens;
}

function headerAt(header: ComposerHeader | undefined): number | null {
  if (header === undefined) return null;
  return msOf(header.createdAt) ?? msOf(header.startedAtMs) ?? msOf(header.completedAtMs);
}

/** Header time when that turn has one, otherwise the composer's own time. */
function stamp(header: ComposerHeader | undefined, composerAt: number | null): number | null {
  return headerAt(header) ?? composerAt;
}

/** Adds one composer's fresh input, cache reads, and output into `usage`. */
export function addComposer(usage: Usage, input: ComposerInput, now: number): void {
  const charge = composerCharge(input);
  const windows = windowOf(now);
  const headers = input.headers ?? [];
  const composerAt = msOf(input.createdAt) ?? msOf(input.lastUpdatedAt);
  const turns = Math.max(1, headers.length);
  addAt(usage, windows, stamp(headers[0], composerAt), charge.fresh + charge.output);
  for (let i = 1; i < turns; i++) addAt(usage, windows, stamp(headers[i], composerAt), charge.stable);
}

export function composerUsage(input: ComposerInput, now: number): Usage {
  const usage = emptyUsage();
  addComposer(usage, input, now);
  return usage;
}

function blankCell(): MatrixCell {
  return {
    usage: emptyUsage(),
    burn: null,
    share: { today: null, "7d": null, "30d": null, "90d": null },
    burn_share: null,
  };
}

function cursorColumn(): MatrixColumn {
  return {
    provider: "cursor",
    label: null,
    name: "Cursor",
    no_quota: false,
    state: "unknown",
    percent: null,
    usage: emptyUsage(),
    burn: null,
  };
}

/**
 * Writes composer usage into one machine's Cursor cell, replacing whatever
 * Burn had counted there. Other cells on the row stay as they are.
 */
export function applyCursorUsage(report: Report, deviceId: string, usage: Usage): void {
  const columns = report.team.matrix.columns;
  let index = columns.findIndex((column) => column.provider === "cursor");
  if (index === -1) {
    columns.push(cursorColumn());
    index = columns.length - 1;
    for (const row of report.team.matrix.rows) row.cells.push(blankCell());
  }
  const row = report.team.matrix.rows.find((item) => item.device_id === deviceId);
  if (row === undefined) return;
  while (row.cells.length <= index) row.cells.push(blankCell());
  const cell = row.cells[index];
  const column = columns[index];
  if (cell === undefined || column === undefined) return;
  const previous = cell.burn ?? cell.usage;
  cell.usage = { today: usage.today, "7d": usage["7d"], "30d": usage["30d"], "90d": usage["90d"] };
  cell.burn = null;
  cell.burn_share = null;
  cell.share = { today: null, "7d": null, "30d": null, "90d": null };
  const rowBase = row.burn ?? row.usage;
  const rowNext = emptyUsage();
  for (const period of PERIODS) rowNext[period] = rowBase[period] - previous[period] + usage[period];
  row.usage = rowNext;
  row.burn = null;
  row.burn_share = null;
  const columnBase = column.burn ?? column.usage;
  const columnNext = emptyUsage();
  for (const period of PERIODS) columnNext[period] = columnBase[period] - previous[period] + usage[period];
  column.usage = columnNext;
  column.burn = null;
}
