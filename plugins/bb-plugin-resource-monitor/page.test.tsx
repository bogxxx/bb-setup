// @vitest-environment jsdom
// The Resources page with several machines: a card each, and the processes
// of the picked one.
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { SAMPLE_CHANNEL } from "./shared";

afterEach(cleanup);

const sample = (cpu: number, hostname: string) => ({
  cpu: { percent: cpu, coreCount: 4, model: "Neoverse-N1" },
  memory: { usedBytes: 8e9, totalBytes: 16e9 },
  gpu: null,
  hostname,
  uptimeSeconds: 7200,
});

const machines = [
  { id: "host_srv", name: "oracle", primary: true, connected: true, lastSeenAt: Date.now(), sample: sample(12, "oracle"), sampledAt: Date.now(), error: null },
  { id: "host_win", name: "Old VM", primary: false, connected: true, lastSeenAt: Date.now(), sample: sample(97, "vm"), sampledAt: Date.now(), error: null },
  { id: "host_off", name: "predator", primary: false, connected: false, lastSeenAt: Date.now() - 8 * 86_400_000, sample: null, sampledAt: null, error: null },
];

it("shows a card per machine and the picked machine's processes", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const feed = renderSlot(app.appOverlays[0]!, {}, {
    rpc: { machines: () => ({ machines: [] }), watch: () => null },
  } as never);
  await feed.emitRealtime(SAMPLE_CHANNEL, { machines });
  const page = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      listProcesses: ({ hostId }: { hostId: string }) => [
        { pid: 7, name: `proc-on-${hostId}`, command: "x", cpuPercent: 1, memoryBytes: 1024, protected: false },
      ],
      guardStatus: () => ({ enabled: false, running: false, pauseAll: false, status: null }),
    },
  } as never);
  expect(await page.findByText("Offline · last seen 8 d ago")).toBeTruthy();
  expect(page.getByText("server")).toBeTruthy();
  expect(page.getByText("97%")).toBeTruthy();
  // The server's processes first, then the machine picked.
  expect(await page.findByText("proc-on-host_srv")).toBeTruthy();
  const radios = page.getAllByRole("radio").map((r) => r.textContent);
  expect(radios).toEqual(["oracle", "Old VM"]);
  fireEvent.click(page.getByRole("radio", { name: "Old VM" }));
  expect(await page.findByText("proc-on-host_win")).toBeTruthy();
  await waitFor(() =>
    expect(
      page.rpcCalls.filter((c) => c.method === "listProcesses").map((c) => (c.input as { hostId: string }).hostId),
    ).toContain("host_win"),
  );
  // The overlay tells the server a window watches.
  expect(feed.rpcCalls.some((c) => c.method === "watch")).toBe(true);
});
