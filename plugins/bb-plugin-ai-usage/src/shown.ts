// The report a machine's page shows. It changes only when a complete merged
// report is ready, so a refresh in progress, or one that failed, leaves the
// page's report as it was.
import { createHash } from "node:crypto";
import type { Report } from "./report.js";

export interface Shown {
  report: Report | null;
  hash: string | null;
  reportAt: number | null;
}

/**
 * A short hash of what the report says. The times and ages that every read restamps (generated_at, an
 * account's quota reading time and age, a device's collection time and age) are left out, so a read
 * that says nothing new is no change.
 */
export function contentHash(report: Report): string {
  const stable: Report = {
    ...report,
    generated_at: "",
    team: {
      ...report.team,
      devices: report.team.devices.map((d) => ({
        ...d,
        age_seconds: 0,
        // A device from live extras has no collection time of its own; the time is stamped on each read.
        collected_at: d.collector_version === "" && !d.old ? null : d.collected_at,
      })),
      providers: report.team.providers.map((p) => ({
        ...p,
        accounts: p.accounts.map((a) => ({ ...a, quota: a.quota === null ? null : { ...a.quota, observed_at: "", age_seconds: 0 } })),
      })),
    },
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 32);
}

/** The shown report after a complete merge: the same state when nothing changed, else the merged report with its time. */
export function nextShown(prev: Shown, merged: Report, now: number): Shown {
  const hash = contentHash(merged);
  if (hash === prev.hash) return prev;
  return { report: merged, hash, reportAt: now };
}

/** What a page that holds `clientHash` is sent: the shown report when it differs, else nothing. */
export function reportForClient(shown: Shown, clientHash: string | null): Report | null {
  return shown.hash !== clientHash ? shown.report : null;
}
