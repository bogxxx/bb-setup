// A provider that failed a review on quota is skipped for at most this long, even when its notice
// names a later reset, so one stale or long notice cannot hold reviews off that provider for days.
export const QUOTA_BLOCK_CAP_MS = 6 * 60 * 60 * 1000;

// A failure that means the provider cannot serve this review: quota, credits, spend limit, or login.
export const QUOTA_CATEGORIES = new Set(["rate-limit", "billing", "budget-exceeded", "unauthorized"]);
// The subset that describes the account rather than one model, so the whole provider is blocked.
export const ACCOUNT_CATEGORIES = new Set(["billing", "budget-exceeded", "unauthorized"]);

/**
 * A reviewer whose thread.start was refused: Copilot answers 403 "not authorized to use this Copilot
 * feature" (category permission_denied), which is not a ProviderErrorInfo category, so it is read from text.
 */
export function isAccountFailureText(text: string): boolean {
  return /permission_denied|not authorized to use|\bunauthorized\b|\b403\b/i.test(text);
}

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

/** The storage key for a block on a whole provider, or on one of its models when a model is given. */
export function blockKey(providerId: string, model?: string): string {
  return model ? `quota-blocked:${providerId}:${model}` : `quota-blocked:${providerId}`;
}

/** The model a reviewer runs on: its model id, or its agent file when it has none (Cursor). */
export function reviewerModelKey(spec: { model?: string; agent?: { name: string } }): string {
  return spec.model ?? spec.agent?.name ?? "";
}
