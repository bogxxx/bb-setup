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

/** A short hash of what the report says. generated_at is left out, so a read that says nothing new is no change. */
export function contentHash(report: Report): string {
  return createHash("sha256").update(JSON.stringify({ ...report, generated_at: "" })).digest("hex").slice(0, 32);
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
