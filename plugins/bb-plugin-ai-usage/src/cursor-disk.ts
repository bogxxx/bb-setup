// Cursor keeps composer rows in state.vscdb. The file is large and rewritten
// often, so a few minutes of cache sits in front of the scan.
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addComposer, emptyUsage, type ComposerCategory, type ComposerHeader, type ComposerInput } from "./cursor-usage.js";
import type { Usage } from "./report.js";

const require = createRequire(import.meta.url);
const CACHE_MS = 5 * 60_000;

interface Sql {
  all(sql: string): Record<string, unknown>[];
  close(): void;
}

interface CacheEntry {
  file: string;
  at: number;
  mtimeMs: number;
  size: number;
  usage: Usage;
}

let cache: CacheEntry | null = null;

function openDb(file: string): Sql | null {
  if (!existsSync(file)) return null;
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, opts: { readOnly: boolean }) => {
      prepare(sql: string): { all(): Record<string, unknown>[] };
      close(): void;
    };
  };
  const db = new DatabaseSync(file, { readOnly: true });
  return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
}

/** Cursor's state database on this machine, or null when Cursor is not installed. */
export function cursorStateFile(): string | null {
  const home = os.homedir();
  const files = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb") : "",
    path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  return files.find((file) => file !== "" && existsSync(file)) ?? null;
}

function copyUsage(usage: Usage): Usage {
  return { today: usage.today, "7d": usage["7d"], "30d": usage["30d"], "90d": usage["90d"] };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function categoriesOf(value: unknown): ComposerCategory[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is ComposerCategory => item !== null && typeof item === "object");
}

function headersOf(value: unknown): ComposerHeader[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is ComposerHeader => item !== null && typeof item === "object");
}

function scan(file: string, now: number): Usage {
  const usage = emptyUsage();
  const db = openDb(file);
  if (db === null) return usage;
  try {
    const rows = db.all(
      `SELECT json_extract(value, '$.promptTokenBreakdown.categories') AS categories,
              json_extract(value, '$.fullConversationHeadersOnly') AS headers,
              json_extract(value, '$.createdAt') AS created_at,
              json_extract(value, '$.lastUpdatedAt') AS updated_at
       FROM cursorDiskKV
       WHERE key LIKE 'composerData:%'
         AND json_extract(value, '$.promptTokenBreakdown.categories') IS NOT NULL`,
    );
    for (const row of rows) {
      const input: ComposerInput = {
        categories: categoriesOf(row.categories),
        headers: headersOf(row.headers),
        createdAt: row.created_at,
        lastUpdatedAt: row.updated_at,
      };
      addComposer(usage, input, now);
    }
    return usage;
  } finally {
    db.close();
  }
}

/**
 * Token windows for every composer on this machine.
 * Null when Cursor's database is not there. A failed read is also null, so a
 * locked file does not wipe the last good figure.
 */
export function readCursorUsage(now: number): Usage | null {
  const file = cursorStateFile();
  if (file === null) return null;
  try {
    const stat = statSync(file);
    const sameFile = cache !== null && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size;
    const fresh = cache !== null && cache.file === file && now - cache.at < CACHE_MS;
    if (cache !== null && (sameFile || fresh)) return copyUsage(cache.usage);
    const usage = scan(file, now);
    cache = { file, at: now, mtimeMs: stat.mtimeMs, size: stat.size, usage };
    return copyUsage(usage);
  } catch {
    return null;
  }
}
