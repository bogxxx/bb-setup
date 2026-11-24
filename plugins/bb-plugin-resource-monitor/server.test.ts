import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { beforeEach, expect, it, vi } from "vitest";

// launchd and the guard home stay untouched: the guard is a fake.
const guard = vi.hoisted(() => {
  const info = (enabled: boolean, pauseAll = false) => ({
    enabled,
    running: false,
    pauseAll,
    status: null,
  });
  return {
    supported: true,
    apply: vi.fn(async (_on: boolean) => {}),
    info: vi.fn(async (enabled: boolean) => info(enabled)),
    setPauseAll: vi.fn(async (paused: boolean, enabled: boolean) =>
      info(enabled, paused),
    ),
  };
});
vi.mock("./guard-install", () => ({ createGuard: () => guard }));

import plugin from "./server";

beforeEach(() => {
  vi.clearAllMocks();
  guard.supported = true;
});

const sampleOf = (cpu: number, used: number, gpu: number | null = null) => ({
  cpu: { percent: cpu, coreCount: 4, model: "CPU" },
  memory: { usedBytes: used, totalBytes: 100 },
  gpu: gpu === null ? null : { percent: gpu, name: "GPU" },
  hostname: "box",
  uptimeSeconds: 60,
});

const hosts = [
  { id: "host_win", name: "VM", status: "connected", type: "persistent", lastSeenAt: 2 },
  { id: "host_srv", name: "oracle", status: "connected", type: "persistent", lastSeenAt: 1 },
  { id: "host_off", name: "predator", status: "disconnected", type: "persistent", lastSeenAt: 3 },
  { id: "host_tmp", name: "sandbox", status: "connected", type: "ephemeral", lastSeenAt: 4 },
];

const load = (
  settings: Record<string, boolean> = {},
  callHost: (call: { method: string; hostId: string; input: unknown }) => unknown = () => {
    throw new Error("no host");
  },
) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "resource-monitor",
    settings,
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_srv" }) },
      hosts: { list: async () => hosts },
    } as never,
    experimental_callHostRpc: callHost,
  });
  plugin(bb);
  return harness;
};

it("samples every connected persistent machine and publishes them, the server first", async () => {
  const harness = load({}, ({ method, hostId }) => {
    if (method !== "sample") throw new Error(method);
    if (hostId === "host_win") throw new Error("timed out");
    return sampleOf(30, 50, 10);
  });
  const { controller, done } = harness.runService("sampler");
  await vi.waitFor(() => expect(harness.inspection.realtimeSignals.length).toBeGreaterThan(0));
  controller.abort();
  await done;
  const sampled = harness.inspection.experimental_hostRpcCalls.map((c) => c.hostId).sort();
  expect(sampled).toEqual(["host_srv", "host_win"]);
  const { machines } = harness.inspection.realtimeSignals[0]!.payload as {
    machines: { id: string; primary: boolean; connected: boolean; sample: unknown; error: string | null }[];
  };
  expect(machines.map((m) => [m.id, m.primary, m.connected])).toEqual([
    ["host_srv", true, true],
    ["host_win", false, true],
    ["host_off", false, false],
  ]);
  expect(machines[0]).toMatchObject({ sample: { cpu: { percent: 30 }, guard: true }, error: null });
  expect(machines[1]).toMatchObject({ sample: null, error: "timed out" });
  expect(machines[2]).toMatchObject({ sample: null, error: null });
});

it("lists and quits processes on the machine the page names, and only a known one", async () => {
  const harness = load({}, ({ method, input }) =>
    method === "listProcesses"
      ? [{ pid: 7, name: "node", command: "node", cpuPercent: 1, memoryBytes: 1, protected: false }]
      : { quit: (input as { pids: number[] }).pids.length, failed: [] },
  );
  expect(await harness.callRpc("listProcesses", { hostId: "host_win" })).toHaveLength(1);
  expect(
    await harness.callRpc("quitProcesses", { hostId: "host_win", pids: [7], force: false }),
  ).toEqual({ quit: 1, failed: [] });
  expect(
    harness.inspection.experimental_hostRpcCalls.map((c) => [c.method, c.hostId, c.input]),
  ).toEqual([
    ["listProcesses", "host_win", {}],
    ["quitProcesses", "host_win", { pids: [7], force: false }],
  ]);
  await expect(harness.callRpc("listProcesses", { hostId: "host_tmp" })).rejects.toThrow(
    "doesn't know",
  );
});

it("installs Guard and turns it off with the setting", async () => {
  const harness = load();
  const { controller, done } = harness.runService("guard");
  await vi.waitFor(() => expect(guard.apply).toHaveBeenCalledWith(true));
  await harness.setSettings({ guard: false });
  await vi.waitFor(() => expect(guard.apply).toHaveBeenLastCalledWith(false));
  controller.abort();
  await done;
});

it("refuses Pause all while Guard is off, but always resumes", async () => {
  const harness = load({ guard: false });
  expect(await harness.callRpc("guardStatus", null)).toMatchObject({
    enabled: false,
  });
  await expect(
    harness.callRpc("setPauseAll", { paused: true }),
  ).rejects.toThrow("Guard is off");
  expect(await harness.callRpc("setPauseAll", { paused: false })).toMatchObject(
    { pauseAll: false },
  );
  await harness.setSettings({ guard: true });
  expect(await harness.callRpc("setPauseAll", { paused: true })).toMatchObject({
    pauseAll: true,
  });
});

it("runs no guard where it is unsupported", () => {
  guard.supported = false;
  expect(() => load().runService("guard")).toThrow();
});
