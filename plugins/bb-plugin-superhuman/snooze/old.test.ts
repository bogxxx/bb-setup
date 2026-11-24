// Snooze Old Threads: which threads count as old, and the snoozes it makes.
import { expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { isOld, UNTIL_NEEDED, type ThreadState } from "./server";

const NOW = Date.now();
const DAY = 86_400_000;
const base: ThreadState = {
  id: "t",
  status: "idle",
  pinnedAt: null,
  updatedAt: NOW - 10 * DAY,
  lastReadAt: NOW - 9 * DAY,
  latestAttentionAt: NOW - 10 * DAY,
  queuedMessageCount: 0,
  activeBackgroundAgentCount: 0,
};
const cutoff = NOW - 3 * DAY;

it("counts a finished, read, unpinned thread untouched since the cutoff as old", () => {
  expect(isOld(base, cutoff)).toBe(true);
  expect(isOld({ ...base, lastReadAt: null, latestAttentionAt: null }, cutoff)).toBe(true);
});

it.each([
  ["running", { status: "active" }],
  ["failed", { status: "error" }],
  ["starting", { status: "starting" }],
  ["pinned", { pinnedAt: NOW - 20 * DAY }],
  ["unread", { latestAttentionAt: NOW - 5 * DAY, lastReadAt: NOW - 6 * DAY }],
  ["never read", { lastReadAt: null }],
  ["recent", { updatedAt: NOW - DAY }],
  ["queued", { queuedMessageCount: 1 }],
  ["with a background agent", { activeBackgroundAgentCount: 1 }],
] as [string, Partial<ThreadState>][])("keeps a %s thread current", (_name, change) => {
  expect(isOld({ ...base, ...change }, cutoff)).toBe(false);
});

it("snoozes old top-level trees until they need you, and keeps a tree with a current child", async () => {
  type Row = ThreadState & { parentThreadId: string | null; visibility: string; archivedAt: number | null };
  const row = (id: string, parentThreadId: string | null, change: Partial<ThreadState> = {}): Row => ({
    ...base, id, parentThreadId, visibility: "visible", archivedAt: null, ...change,
  });
  const rows: Record<string, Row> = {
    old: row("old", null),
    oldKid: row("oldKid", "old"),
    busy: row("busy", null),
    busyKid: row("busyKid", "busy", { status: "active" }),
    fresh: row("fresh", null, { updatedAt: NOW }),
  };
  const response = (id: string) => ({ ...makeThreadResponse({ id, title: `Thread ${id}`, parentThreadId: rows[id].parentThreadId }), ...rows[id] });
  const { bb, harness } = createFakePluginHost({
    pluginId: "superhuman",
    sdk: {
      threads: {
        get: (async ({ threadId }: { threadId: string }) => response(threadId)) as never,
        list: (async (args: { parentThreadId?: string; offset?: number }) =>
          (args.offset ?? 0) > 0
            ? []
            : Object.keys(rows)
                .filter((id) => rows[id].parentThreadId === (args.parentThreadId ?? null))
                .map(response)) as never,
        update: (async (args: { threadId: string; visibility: string }) => {
          rows[args.threadId].visibility = args.visibility;
          return response(args.threadId);
        }) as never,
        markUnread: (async () => ({})) as never,
      },
    },
  });
  const settings = bb.settings.define({
    snooze: { type: "boolean", label: "Snooze", default: true },
    snoozeOldThreads: { type: "number", label: "Old", default: 3 },
  });
  await plugin(bb, settings);
  const result = await harness.behavior.callRpc("snoozeOld", { days: 3 });
  expect(result).toEqual({ snoozed: 1, checked: 3 });
  expect(rows.old.visibility).toBe("hidden");
  expect(rows.oldKid.visibility).toBe("hidden");
  expect(rows.busy.visibility).toBe("visible");
  expect(rows.fresh.visibility).toBe("visible");
  const { snoozes } = (await harness.behavior.callRpc("listSnoozes", null)) as {
    snoozes: { threadId: string; until: number }[];
  };
  expect(snoozes).toEqual([{ threadId: "old", title: "Thread old", until: UNTIL_NEEDED }]);
  // A second run leaves the snoozed tree alone.
  expect(await harness.behavior.callRpc("snoozeOld", { days: 3 })).toEqual({ snoozed: 0, checked: 2 });
});
