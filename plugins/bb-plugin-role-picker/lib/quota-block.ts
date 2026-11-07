// A provider that failed a review on quota is skipped for at most this long, even when its notice
// names a later reset, so one stale or long notice cannot hold reviews off that provider for days.
export const QUOTA_BLOCK_CAP_MS = 6 * 60 * 60 * 1000;

export type QuotaBlock = { until: number; setAt: number };

/** A stored block, or null for anything else (including the numeric entries older versions wrote). */
export function parseQuotaBlock(stored: unknown): QuotaBlock | null {
  if (!stored || typeof stored !== "object") return null;
  const { until, setAt } = stored as Partial<QuotaBlock>;
  if (typeof until !== "number" || typeof setAt !== "number") return null;
  return { until, setAt };
}

/** When a block stops applying: its reset time, capped at QUOTA_BLOCK_CAP_MS after it was set. */
export function quotaBlockEnd(block: QuotaBlock): number {
  return Math.min(block.until, block.setAt + QUOTA_BLOCK_CAP_MS);
}
