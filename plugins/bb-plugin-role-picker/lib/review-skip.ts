/** The reviewer spawn this host lookup is about. */
export type ReviewHostRecord = {
  environmentId: string | null;
  projectId: string;
};

export type ReviewHostSource = { hostId: string; isDefault: boolean };

/** Lookups are passed in so tests can fake the SDK. */
export type ReviewHostDeps = {
  getEnvironment: (environmentId: string) => Promise<{ hostId: string }>;
  getProject: (projectId: string) => Promise<{ sources: readonly ReviewHostSource[] }>;
};

/**
 * The machine the reviewer will run on.
 * An environment id is that environment's host. With no environment, the spawn is
 * project-default: the source marked isDefault, or the only source when there is one.
 * A lookup error or an empty host id returns null. Per-machine usage statuses then fail open.
 */
export async function resolveReviewHostId(record: ReviewHostRecord, deps: ReviewHostDeps): Promise<string | null> {
  try {
    if (record.environmentId) {
      const environment = await deps.getEnvironment(record.environmentId);
      return environment.hostId || null;
    }
    const project = await deps.getProject(record.projectId);
    const sources = project.sources ?? [];
    const marked = sources.find((source) => source.isDefault);
    if (marked) return marked.hostId || null;
    if (sources.length === 1) return sources[0]?.hostId || null;
    return null;
  } catch {
    return null;
  }
}

/** A usage-limits entry. `unknown` is not in the SDK union; anything else fails open. */
export type UsageSkipEntry = {
  status: string;
  windows?: readonly { label?: string; usedPercent: number }[];
};

// Words that name a model family in a usage window label, such as "Gemini 4 Argon" or "Gemini 3.8 Flash".
const FAMILY_WORDS = ["argon", "flash", "pro", "lite", "opus", "sonnet", "haiku", "sol", "terra"];

function namedFamilies(text: string): Set<string> {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/));
  return new Set(FAMILY_WORDS.filter((family) => words.has(family)));
}

/**
 * Whether a usage window applies to this model. A window whose label names no model family is
 * account-wide and applies to every model; one that names a family applies only to that family.
 */
export function windowAppliesTo(label: string, model: string): boolean {
  const labelFamilies = namedFamilies(label);
  if (labelFamilies.size === 0) return true;
  const modelFamilies = namedFamilies(model);
  return [...labelFamilies].some((family) => modelFamilies.has(family));
}

/** Query for the reviewer's host. No hostId means the caller did not resolve one. */
export function usageLimitsQuery(providerId: string, hostId: string | null): { providerId: string; hostId?: string } {
  return hostId ? { providerId, hostId } : { providerId };
}

/**
 * Why this usage entry skips a review, or null when the provider can be tried.
 * not_installed, unauthenticated and expired describe one machine, so they skip
 * only after that machine was resolved. A window at 100% or more skips when it applies to the
 * model (see windowAppliesTo); with no model, any such window skips.
 */
export function usageSkip(entry: UsageSkipEntry | null | undefined, hostResolved: boolean, model?: string): string | null {
  if (!entry) return null;
  if (
    hostResolved &&
    (entry.status === "not_installed" || entry.status === "unauthenticated" || entry.status === "expired")
  ) {
    return `usage report says ${entry.status}`;
  }
  const usedUp = (window: { label?: string; usedPercent: number }) =>
    window.usedPercent >= 100 && (!model || windowAppliesTo(window.label ?? "", model));
  if (entry.status === "ok" && entry.windows?.some(usedUp)) {
    return "usage report says a window is used up";
  }
  return null;
}
