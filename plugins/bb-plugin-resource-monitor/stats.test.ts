import { describe, expect, it } from "vitest";
import {
  cpuPercent,
  parseIoreg,
  parseMemInfo,
  parseNvidiaSmi,
  parseVmStat,
} from "./stats";

describe("cpuPercent", () => {
  it("gives the busy share since the last reading", () => {
    expect(cpuPercent({ busy: 100, total: 1000 }, { busy: 150, total: 1100 })).toBe(50);
  });

  it("gives 0 when no time passed", () => {
    expect(cpuPercent({ busy: 1, total: 10 }, { busy: 1, total: 10 })).toBe(0);
  });
});

describe("parseVmStat", () => {
  it("counts app memory, wired, and compressed pages", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                    32359.",
      "Pages wired down:                             100.",
      "Pages purgeable:                                10.",
      "Anonymous pages:                              200.",
      "Pages occupied by compressor:                   50.",
    ].join("\n");
    expect(parseVmStat(text)).toBe((200 - 10 + 100 + 50) * 16384);
  });

  it("returns null when a field is missing", () => {
    expect(parseVmStat("(page size of 16384 bytes)")).toBeNull();
  });
});

describe("parseMemInfo", () => {
  it("counts everything but available memory", () => {
    const text = "MemTotal:       1000 kB\nMemFree: 100 kB\nMemAvailable:    400 kB\n";
    expect(parseMemInfo(text)).toBe(600 * 1024);
  });
});

describe("parseIoreg", () => {
  it("reads the accelerator's utilization and model", () => {
    const text = `"model" = "Apple M4"\n"PerformanceStatistics" = {"Device Utilization %"=13,"In use system memory"=2048}`;
    expect(parseIoreg(text)).toEqual({ percent: 13, name: "Apple M4" });
  });

  it("returns null without utilization", () => {
    expect(parseIoreg(`"model" = "Apple M4"`)).toBeNull();
  });
});

describe("parseNvidiaSmi", () => {
  it("picks the busiest GPU", () => {
    const text = "NVIDIA A100, 12\nNVIDIA H100, 80\n";
    expect(parseNvidiaSmi(text)).toEqual({ name: "NVIDIA H100", percent: 80 });
  });

  it("returns null for empty output", () => {
    expect(parseNvidiaSmi("")).toBeNull();
  });
});
