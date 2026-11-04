// What a machine's ai-usage report becomes on the server. The machine's own
// logins are not read here: each connected machine adds its logins through
// its extras call, so this server never reads its own sign-ins.
import { alignCost } from "./local-providers.js";
import { readReport, type Report } from "./report.js";

/** The report with its cost line aligned to the weekly limit. Throws when the JSON is not a report. */
export function readTaken(json: unknown): Report {
  const report = readReport(json);
  alignCost(report);
  return report;
}
