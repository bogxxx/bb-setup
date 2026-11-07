// Extra usage comes from bb's account pool, not from ai-usage: the pool knows
// which Claude sign-in carries extra usage and whether it is allowed. This
// reads the pool's answer and puts it on the Claude account it belongs to.
import { z } from "zod";
import type { Report } from "./report.js";

/** The pool's status, read leniently: a field the pool leaves out reads as absent. */
export const poolStatusSchema = z
  .object({
    accounts: z.array(
      z
        .object({
          provider: z.string(),
          email: z.string().nullish(),
          extraUsage: z.object({ status: z.string(), observedAt: z.union([z.string(), z.number()]).nullish() }).passthrough().nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type PoolStatus = z.infer<typeof poolStatusSchema>;

/** The pool's time as the report writes times: ISO 8601. The pool gives epoch milliseconds. */
function isoTime(v: string | number | null | undefined): string | null {
  if (typeof v === "string") return v;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Sets `extra_usage` on each Claude account whose label, or name when it has
 * none, is the email of exactly one pool account for Claude. An account with
 * no single match keeps what it had; the match ignores case.
 */
export function applyPoolExtraUsage(report: Report, pool: PoolStatus["accounts"]): Report {
  const claude = pool.filter((a) => a.provider === "claude" && (a.email ?? "") !== "");
  const matches = (key: string) => claude.filter((a) => (a.email ?? "").toLowerCase() === key);
  return {
    ...report,
    team: {
      ...report.team,
      providers: report.team.providers.map((p) =>
        p.provider !== "claude"
          ? p
          : {
              ...p,
              accounts: p.accounts.map((a) => {
                const key = (a.label !== "" ? a.label : a.name).toLowerCase();
                const found = matches(key);
                const only = found.length === 1 ? found[0] : undefined;
                if (only === undefined || only.extraUsage === null || only.extraUsage === undefined) return a;
                return { ...a, extra_usage: { status: only.extraUsage.status, observed_at: isoTime(only.extraUsage.observedAt) } };
              }),
            },
      ),
    },
  };
}
