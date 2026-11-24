import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

afterEach(() => vi.useRealTimers());

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "storage-cleaner" });
  plugin(bb);
  return harness;
}

it("registers its settings, RPC methods and nightly schedule", async () => {
  const { registrations } = (await setup()).inspection;
  const settings = Object.entries(registrations.settingsDescriptors).map(
    ([key, d]) => [key, d.default],
  );
  expect(settings).toEqual([
    ["nightlyScan", true],
    ["cleanArchivedThreads", false],
    ["cleanLeftoverWorktrees", false],
    ["cleanDevCaches", false],
    ["cleanTrash", false],
  ]);
  expect(registrations.rpcMethods.sort()).toEqual([
    "storageClean",
    "storageDelete",
    "storageFolder",
    "storageMachines",
    "storageOpenFullDiskAccess",
    "storageRescan",
    "storageSnapshot",
  ]);
  expect(registrations.schedules.map(({ name, cron }) => [name, cron])).toEqual(
    [["storageNightly", "0 * * * *"]],
  );
});

it("does nothing in an hour other than the one at 00:00 UTC", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-12T12:00:00Z"));
  const harness = await setup();
  await harness.behavior.runSchedule("storageNightly");
  expect(harness.inspection.realtimeSignals).toEqual([]);
});
