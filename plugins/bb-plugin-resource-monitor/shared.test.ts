import { expect, it } from "vitest";
import { busiest, type MachineSample, type Sample } from "./shared";

const sample = (cpu: number, used: number, gpu: number | null): Sample => ({
  cpu: { percent: cpu, coreCount: 4, model: "CPU" },
  memory: { usedBytes: used, totalBytes: 100 },
  gpu: gpu === null ? null : { percent: gpu, name: "GPU" },
  hostname: "box",
  uptimeSeconds: 1,
});

const machine = (id: string, s: Sample | null, connected = true): MachineSample => ({
  id,
  name: id,
  primary: false,
  connected,
  lastSeenAt: 1,
  sample: s,
  sampledAt: 1,
  error: null,
});

it("shows each bar at its busiest connected machine", () => {
  const icon = busiest([
    machine("a", sample(90, 20, null)),
    machine("b", sample(10, 80, 40)),
    machine("off", sample(100, 100, 100), false),
  ]);
  expect(icon?.cpu.percent).toBe(90);
  expect(icon?.memory.usedBytes).toBe(80);
  expect(icon?.gpu?.percent).toBe(40);
});

it("shows nothing without a connected sample", () => {
  expect(busiest([machine("a", null), machine("b", sample(1, 1, 1), false)])).toBeNull();
});
