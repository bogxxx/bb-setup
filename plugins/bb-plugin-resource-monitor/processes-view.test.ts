import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "./contract";
import {
  filterProcesses,
  formatCpu,
  formatMemory,
  nextSort,
  quitMessage,
  sortProcesses,
} from "./processes-view";

const proc = (
  pid: number,
  name: string,
  cpuPercent = 0,
  memoryBytes = 0,
): ProcessInfo => ({
  pid,
  name,
  command: `/usr/bin/${name} --flag`,
  cpuPercent,
  memoryBytes,
  protected: false,
});

const procs = [
  proc(30, "node", 12.5, 300e6),
  proc(4, "Safari", 140, 2e9),
  proc(512, "launchd", 0, 20e6),
  proc(7, "zsh", 0, 5e6),
];
const pids = (list: ProcessInfo[]) => list.map((p) => p.pid);

describe("filterProcesses", () => {
  it("matches the name, command, or PID, ignoring case", () => {
    expect(pids(filterProcesses(procs, " SAFARI "))).toEqual([4]);
    expect(pids(filterProcesses(procs, "bin/zsh"))).toEqual([7]);
    expect(pids(filterProcesses(procs, "51"))).toEqual([512]);
  });

  it("keeps every process for an empty query", () => {
    expect(filterProcesses(procs, "  ")).toBe(procs);
  });
});

describe("sortProcesses", () => {
  it("sorts numbers and breaks ties by PID", () => {
    const sort = { key: "cpuPercent", descending: true } as const;
    expect(pids(sortProcesses(procs, sort))).toEqual([4, 30, 7, 512]);
  });

  it("sorts names without regard to case", () => {
    const sort = { key: "name", descending: false } as const;
    expect(pids(sortProcesses(procs, sort))).toEqual([512, 30, 4, 7]);
  });
});

describe("nextSort", () => {
  it("starts names A→Z and numbers high→low, then flips", () => {
    const byCpu = { key: "cpuPercent", descending: true } as const;
    expect(nextSort(byCpu, "name")).toEqual({ key: "name", descending: false });
    expect(nextSort(byCpu, "pid")).toEqual({ key: "pid", descending: true });
    expect(nextSort(byCpu, "cpuPercent")).toEqual({
      key: "cpuPercent",
      descending: false,
    });
  });
});

describe("format", () => {
  it("shows CPU with one decimal", () => {
    expect(formatCpu(140)).toBe("140.0");
    expect(formatCpu(0.04)).toBe("0.0");
  });

  it("shows KB under 1 MB, MB under 1 GB, else GB", () => {
    expect(formatMemory(640 * 1024)).toBe("640 KB");
    expect(formatMemory(300 * 1024 ** 2)).toBe("300 MB");
    expect(formatMemory(1023.9 * 1024 ** 2)).toBe("1.0 GB");
    expect(formatMemory(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });

  it("sums up a quit", () => {
    expect(quitMessage({ quit: 3, failed: [] })).toBe("Quit 3 processes");
    expect(
      quitMessage({ quit: 2, failed: [{ pid: 1, reason: "Not permitted" }] }),
    ).toBe("Quit 2 processes; 1 couldn’t be quit: Not permitted");
    expect(
      quitMessage({ quit: 0, failed: [{ pid: 1, reason: "Not permitted" }] }),
    ).toBe("Couldn’t quit 1 process: Not permitted");
  });
});
