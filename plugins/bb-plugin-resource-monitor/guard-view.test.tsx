// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { SAMPLE_CHANNEL, type GuardInfo, type GuardStatus } from "./shared";

afterEach(cleanup);

const T0 = new Date(2026, 9, 22, 9, 5).getTime();

const status = (
  mode: GuardStatus["mode"],
  events: GuardStatus["events"] = [],
): GuardStatus => ({
  updatedAt: T0,
  mode,
  counts: { background: 3, paused: 12 },
  events,
});

const info = (extra: Partial<GuardInfo> = {}): GuardInfo => ({
  enabled: true,
  running: true,
  pauseAll: false,
  status: status("normal"),
  ...extra,
});

const paused = info({ pauseAll: true, status: status("paused") });
const overload = info({ status: status("overload") });

/** The Resources page after one sample; `guard` null: an older server. */
async function renderPage(
  guardInfo: GuardInfo,
  rpc: object = {},
  guard: boolean | null = true,
) {
  const app = await loadPluginApp(() => import("./app"));
  const feed = renderSlot(app.appOverlays[0]!, {});
  await feed.emitRealtime(SAMPLE_CHANNEL, {
    machines: [
      {
        id: "host_mac",
        name: "mac",
        primary: true,
        connected: true,
        lastSeenAt: T0,
        sampledAt: T0,
        error: null,
        sample: {
          cpu: { percent: 20, coreCount: 10, model: "Apple M4" },
          memory: { usedBytes: 8e9, totalBytes: 16e9 },
          gpu: null,
          hostname: "mac.local",
          uptimeSeconds: 3600,
          ...(guard !== null && { guard }),
        },
      },
    ],
  });
  rpc = { listProcesses: () => [], guardStatus: () => guardInfo, ...rpc };
  const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc } as never);
  await page.findByText("0 processes");
  const calls = (method: string) =>
    page.rpcCalls.filter((c) => c.method === method).map((c) => c.input);
  const section = async () =>
    within(await page.findByRole("region", { name: "Guard" }));
  return Object.assign(page, { feed, calls, section });
}

it.each([
  ["off", info({ enabled: false }), /^Off\./, null],
  ["stopped", { ...paused, running: false }, "Not running", "Resume all"],
  ["normal", info(), "Normal", "Pause all"],
  ["overload", overload, "Overload: 3 on efficiency cores", "Pause all"],
  ["paused", paused, "Paused: 12 processes", "Resume all"],
])("shows Guard %s", async (_, guard, line, button) => {
  const section = await (await renderPage(guard)).section();
  expect(await section.findByText(line)).toBeTruthy();
  expect(section.queryByRole("button")?.textContent ?? null).toBe(button);
});

it("lists the last 4 events, newest first, with local times", async () => {
  const events = [0, 1, 2, 3, 4].map((n) => ({
    at: T0 + n * 60_000,
    message: `Event ${n}`,
    error: n === 3,
  }));
  const page = await renderPage(info({ status: status("normal", events) }));
  const items = await (await page.section()).findAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    "09:09 Event 4",
    "09:08 Event 3",
    "09:07 Event 2",
    "09:06 Event 1",
  ]);
  expect(items[1]!.className).toBe("text-destructive");
});

it("asks before Pause all, and resumes at once", async () => {
  let now = info();
  const page = await renderPage(now, {
    guardStatus: () => now,
    setPauseAll: (input: { paused: boolean }) =>
      (now = input.paused ? paused : info()),
  });
  const section = await page.section();
  fireEvent.click(await section.findByRole("button", { name: "Pause all" }));
  const dialog = within(await page.findByRole("alertdialog"));
  expect(page.calls("setPauseAll")).toEqual([]);
  fireEvent.click(dialog.getByRole("button", { name: "Pause all" }));
  fireEvent.click(await section.findByRole("button", { name: "Resume all" }));
  await section.findByRole("button", { name: "Pause all" });
  expect(page.calls("setPauseAll")).toEqual([
    { paused: true },
    { paused: false },
  ]);
});

it("stays through a dropped connection", async () => {
  const page = await renderPage(paused);
  await (await page.section()).findByRole("button", { name: "Resume all" });
  await page.feed.setRealtimeConnectionState("reconnecting");
  expect(page.queryByText("mac · up 1h 0m")).toBeNull();
  const section = await page.section();
  expect(section.getByRole("button", { name: "Resume all" })).toBeTruthy();
});

it.each([false, null])("stays away: guard %s", async (guard) => {
  const page = await renderPage(info(), {}, guard);
  expect(page.queryByRole("region", { name: "Guard" })).toBeNull();
  expect(page.calls("guardStatus")).toEqual([]);
});
