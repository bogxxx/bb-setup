// What a machine's ai-usage report becomes on the server. The machine's own
// logins are not read here: each connected machine adds its logins through
// its extras call, so this server never reads its own sign-ins.
import { alignCost, machineInMatrix, mergeMeasured } from "./local-providers.js";
import { readReport, type Report } from "./report.js";

/** The report with its cost line aligned to the weekly limit. Throws when the JSON is not a report. */
export function readTaken(json: unknown): Report {
  const report = readReport(json);
  alignCost(report);
  return report;
}

type Providers = Parameters<typeof mergeMeasured>[1]["providers"];

/**
 * Adds one machine to the report: its live reading, else its last snapshot marked with when it was seen,
 * and its matrix row. `fallbackUser` is used only when neither reading has an OS user.
 */
export function mergeMachine(
  report: Report,
  machine: { id: string; name: string },
  live: { hostName: string; user: string; providers: Providers } | null,
  snap: { at: number; alias: string; user: string; providers: Providers } | null,
  fallbackUser: string,
): void {
  // A reading matches this machine by its BB name or the OS hostname it reports under, never by OS user.
  if (live !== null) mergeMeasured(report, { ...live, hostName: machine.name }, { aliases: [live.hostName] });
  else if (snap !== null) mergeMeasured(report, { hostName: machine.name, user: snap.user, providers: snap.providers }, { measuredAt: snap.at, aliases: snap.alias ? [snap.alias] : [] });
  // The row does not depend on extras: its OS user comes from the live reading, the snapshot, or the probe.
  const user = [live?.user, snap?.user, fallbackUser].find((u) => u !== undefined && u !== "") ?? "";
  machineInMatrix(report, machine.name, user, machine.id, [live?.hostName ?? snap?.alias ?? ""]);
}
