// A machine's matrix row is found by its BB name or by the OS hostname its own
// ai-usage reports under, so one machine is one row.
import { expect, test } from "bun:test";
import demoTeam from "../demo/team.json" with { type: "json" };
import { machineInMatrix } from "../src/local-providers";
import { readReport } from "../src/report";

test("a machine reported under its OS hostname keeps the one row it already has", () => {
  const report = readReport(structuredClone(demoTeam));
  report.team.matrix.rows = [];
  machineInMatrix(report, "instance-20260228-2343", "opc", "d-team-row");
  expect(report.team.matrix.rows[0]!.device).toBe("opc@instance-20260228-2343");
  const before = report.team.matrix.rows.length;
  machineInMatrix(report, "oracle", "opc", "host_oracle", ["instance-20260228-2343"]);
  expect(report.team.matrix.rows.length).toBe(before);
  expect(report.team.matrix.rows[0]!.device_id).toBe("host_oracle");
});
