import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { matchTitle } from "./search";
import { CHANGED_CHANNEL } from "./shared";
import type { Choice } from "./time";

/** The wake timer sleeps at most this long, so it catches up soon after the computer sleeps. */
const MAX_SLEEP = 60_000;

const threadIdSchema = z.string().min(1).max(200);

const choiceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("preset"),
      id: z.enum(["later", "tomorrow", "nextweek"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("text"), text: z.string().min(1).max(200) })
    .strict(),
]);

const snoozeSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  until: z.number(),
});

export type Snooze = z.infer<typeof snoozeSchema>;

export const rpcContract = defineRpcContract({
  listSnoozes: {
    input: z.null(),
    output: z.object({
      /** Soonest wake first. */
      snoozes: z.array(snoozeSchema),
      last: choiceSchema.nullable(),
    }),
  },
  snooze: {
    input: z
      .object({
        threadId: threadIdSchema,
        until: z.number().int().positive(),
        /** Stored as Last used; null keeps the stored one. */
        choice: choiceSchema.nullable(),
      })
      .strict(),
    output: z.object({
      /** The thread's title, for the toast. */
      title: z.string(),
      /** When the thread was already snoozed, its previous wake time. */
      previous: z.number().nullable(),
      /** Every thread the snooze hides: the thread and its descendants. */
      hidden: z.array(z.string()),
    }),
  },
  unsnooze: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.null(),
  },
  snoozeOld: {
    input: z.object({ days: z.number().int().min(1).max(3650) }).strict(),
    output: z.object({ snoozed: z.number(), checked: z.number() }),
  },
  searchSnoozes: {
    input: z
      .object({ queries: z.array(z.string().min(1).max(256)).min(1).max(2) })
      .strict(),
    output: z.object({
      /** Hidden threads whose title matches, as BB's search returns them. */
      results: z.array(
        z.object({
          /** The thread's row in BB's thread list. */
          thread: z.looseObject({ id: z.string(), updatedAt: z.number() }),
          matches: z.array(
            z.object({
              sourceKind: z.enum(["title", "title_fallback"]),
              text: z.string(),
              highlightRanges: z.array(
                z.object({ start: z.number(), end: z.number() }),
              ),
              sourceSeq: z.null(),
            }),
          ),
        }),
      ),
    }),
  },
});

interface StoredSnooze {
  title: string;
  until: number;
  /** The threads the snooze hid, parents first. */
  hidden: string[];
}

type Snoozes = Record<string, StoredSnooze>;

/** The part of the root settings handle that Snooze reads. */
interface SnoozeSettings {
  get(): Promise<{ snooze?: boolean; snoozeOldThreads?: number }>;
  onChange(
    listener: (next: { snooze?: boolean; snoozeOldThreads?: number }) => void,
  ): void;
}

/** Old threads sleep until they need you: far off, so no time wakes them. */
export const UNTIL_NEEDED = Date.UTC(2100, 0, 1);
const DAY = 86_400_000;

/** The thread fields that say whether a thread is current. */
export interface ThreadState {
  id: string;
  status: string;
  pinnedAt: number | null;
  updatedAt: number;
  lastReadAt: number | null;
  latestAttentionAt: number | null;
  queuedMessageCount?: number;
  activeBackgroundAgentCount?: number;
}

/**
 * Whether a thread is done with for now: not running, failed or waiting, not
 * pinned, read, and untouched since `cutoff`.
 */
export function isOld(thread: ThreadState, cutoff: number) {
  const unread =
    thread.latestAttentionAt !== null &&
    (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt);
  return (
    thread.status === "idle" &&
    thread.pinnedAt === null &&
    !unread &&
    thread.updatedAt < cutoff &&
    !thread.queuedMessageCount &&
    !thread.activeBackgroundAgentCount
  );
}

export default async function registerSnoozeServer(
  bb: BbPluginApi,
  settings: SnoozeSettings,
) {
  const { threads } = bb.sdk;
  const { kv } = bb.storage;

  // Every change to the snoozes runs in this queue, one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }

  const load = async () => (await kv.get<Snoozes>("snoozes")) ?? {};
  const save = (snoozes: Snoozes) => kv.set("snoozes", snoozes);
  const publishChange = () => bb.realtime.publish(CHANGED_CHANNEL, null);
  const warn = (message: string, error: unknown) =>
    bb.log.warn(`${message}: ${String(error)}`);

  async function setVisibility(
    threadId: string,
    visibility: "hidden" | "visible",
  ) {
    try {
      await threads.update({ threadId, visibility });
    } catch (error) {
      warn(`Could not make thread ${threadId} ${visibility}`, error);
    }
  }

  /** The thread and its descendants that the sidebar shows, parents first. */
  async function visibleTree(thread: { id: string; visibility: string }) {
    const visible = thread.visibility === "visible" ? [thread.id] : [];
    const all = [thread.id];
    for (const parentThreadId of all) {
      const children = await threads.list({
        parentThreadId,
        includeHidden: true,
      });
      for (const child of children) {
        all.push(child.id);
        if (child.visibility === "visible") visible.push(child.id);
      }
    }
    return visible;
  }

  async function snooze(
    threadId: string,
    until: number,
    choice: Choice | null,
  ) {
    const thread = await threads.get({ threadId });
    const tree = await visibleTree(thread);
    const snoozes = await load();
    const previous = snoozes[threadId];
    const hidden = [...new Set([...(previous?.hidden ?? []), ...tree])];
    const title = thread.title ?? thread.titleFallback ?? "Untitled thread";
    snoozes[threadId] = { title, until, hidden };
    await save(snoozes);
    if (choice !== null) await kv.set("lastSnoozeChoice", choice);
    // Deepest first: BB lifts a visible child of a hidden thread to the top.
    for (const id of [...tree].reverse()) await setVisibility(id, "hidden");
    publishChange();
    return { title, previous: previous?.until ?? null, hidden };
  }

  async function wake(threadId: string, markUnread: boolean) {
    const snoozes = await load();
    const snooze = snoozes[threadId];
    if (snooze === undefined) return;
    for (const id of snooze.hidden) await setVisibility(id, "visible");
    delete snoozes[threadId];
    await save(snoozes);
    if (markUnread) {
      await threads
        .markUnread({ threadId })
        .catch((error: unknown) =>
          warn(`Could not mark thread ${threadId} unread`, error),
        );
    }
    publishChange();
  }

  /** Wake the snooze of `threadId`, or with `orHidden` also the one hiding it. */
  function wakeWith(threadId: string, orHidden: boolean) {
    return serial(async () => {
      for (const [id, snooze] of Object.entries(await load())) {
        if (id === threadId || (orHidden && snooze.hidden.includes(threadId))) {
          await wake(id, false);
        }
      }
    });
  }

  /** As `wakeWith`, logging a failure. */
  function wakeOn(threadId: string, orHidden: boolean) {
    return wakeWith(threadId, orHidden).catch((error: unknown) =>
      warn(`Could not wake thread ${threadId}`, error),
    );
  }

  bb.rpc.register(rpcContract, {
    async listSnoozes() {
      const snoozes = Object.entries(await load())
        .map(([threadId, { title, until }]) => ({ threadId, title, until }))
        .sort((a, b) => a.until - b.until);
      const last = await kv.get<Choice>("lastSnoozeChoice");
      return { snoozes, last: last ?? null };
    },
    async snooze({ threadId, until, choice }) {
      if (!on) throw new Error("Snooze is off in Superhuman's settings.");
      const result = await serial(() => snooze(threadId, until, choice));
      wakeTimer();
      return result;
    },
    async unsnooze({ threadId }) {
      await wakeWith(threadId, true);
      return null;
    },
    async snoozeOld({ days }) {
      if (!on) throw new Error("Snooze is off in Superhuman's settings.");
      return snoozeOld(days);
    },
    async searchSnoozes({ queries }) {
      const snoozes = Object.values(await load());
      const ids = new Set(snoozes.flatMap(({ hidden }) => hidden));
      // BB's search returns thread list rows; each list is read once.
      const lists = new Map<string, ReturnType<typeof threads.list>>();
      const results = await Promise.all(
        [...ids].map(async (threadId) => {
          const thread = await threads.get({ threadId }).catch(() => null);
          if (
            thread === null ||
            thread.archivedAt !== null ||
            thread.deletedAt !== null ||
            thread.visibility !== "hidden"
          ) {
            return [];
          }
          const text = thread.title || thread.titleFallback || "";
          const highlightRanges = matchTitle(text, queries);
          if (highlightRanges === null) return [];
          const { parentThreadId, environmentId, projectId } = thread;
          // The smallest list that holds the thread.
          const scope =
            parentThreadId !== null
              ? { parentThreadId }
              : environmentId !== null
                ? { environmentId, hasParent: false }
                : { projectId, hasParent: false };
          const key = JSON.stringify(scope);
          let list = lists.get(key);
          if (list === undefined) {
            list = threads
              .list({ ...scope, includeHidden: true, archived: false })
              .catch(() => []);
            lists.set(key, list);
          }
          const row = (await list).find((row) => row.id === threadId);
          if (row === undefined) return [];
          const match = {
            sourceKind: thread.title ? "title" : "title_fallback",
            text,
            highlightRanges,
            sourceSeq: null,
          } as const;
          return [{ thread: row, matches: [match] }];
        }),
      );
      return { results: results.flat() };
    },
  });

  // Turned off, Snooze brings every snoozed thread back at once, so none stays
  // hidden with nothing to find it by.
  function wakeAll() {
    serial(async () => {
      for (const threadId of Object.keys(await load())) await wake(threadId, false);
    }).catch((error: unknown) => warn("Could not wake the snoozed threads", error));
  }
  let on = (await settings.get()).snooze !== false;
  if (!on) wakeAll();
  settings.onChange((next) => {
    on = next.snooze !== false;
    if (!on) wakeAll();
  });

  // A turn that ends or fails, or an agent that needs an answer, wakes the
  // thread at once. Archiving or deleting it drops the snooze.
  bb.events.on("thread.idle", ({ thread }) => wakeOn(thread.id, false));
  bb.events.on("thread.failed", ({ thread }) => wakeOn(thread.id, false));
  bb.events.on("thread.archived", ({ thread }) => wakeOn(thread.id, false));
  bb.events.on("thread.deleted", ({ thread }) => wakeOn(thread.id, false));
  bb.events.on("interaction.pending", ({ thread }) => wakeOn(thread.id, true));

  let wakeTimer = () => {};

  /**
   * Snoozes, until they need you, the top-level threads whose whole tree is
   * old (see isOld). Each thread is read again right before its snooze, so one
   * that started meanwhile stays.
   */
  async function snoozeOld(days: number) {
    const cutoff = Date.now() - days * DAY;
    const snoozed = new Set(Object.keys(await load()));
    let checked = 0;
    let count = 0;
    const tops: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await threads.list({ archived: false, limit: 200, offset });
      for (const t of page)
        if (t.parentThreadId === null && t.visibility === "visible") tops.push(t.id);
      if (page.length < 200) break;
    }
    for (const threadId of tops) {
      if (snoozed.has(threadId)) continue;
      checked++;
      const thread = await threads.get({ threadId }).catch(() => null);
      if (!thread || thread.archivedAt !== null || !isOld(thread, cutoff)) continue;
      // A current descendant keeps its whole tree in view.
      let current = false;
      const tree = [threadId];
      for (const parentThreadId of tree) {
        const kids = await threads.list({ parentThreadId, includeHidden: true });
        for (const kid of kids) {
          if (kid.archivedAt === null && !isOld(kid, cutoff)) current = true;
          tree.push(kid.id);
        }
        if (current) break;
      }
      if (current) continue;
      await serial(() => snooze(threadId, UNTIL_NEEDED, null));
      count++;
    }
    if (count) {
      bb.log.info(`snoozed ${count} old threads (untouched for ${days}+ days)`);
      wakeTimer();
    }
    return { snoozed: count, checked };
  }

  // Every hour, old threads snooze, when Snooze and Snooze Old Threads are on.
  let snoozingOld = false;
  async function snoozeOldNow() {
    const days = Math.floor((await settings.get()).snoozeOldThreads ?? 3);
    if (!on || days < 1 || snoozingOld) return;
    snoozingOld = true;
    try {
      await snoozeOld(days);
    } catch (error) {
      warn("Could not snooze old threads", error);
    } finally {
      snoozingOld = false;
    }
  }
  bb.background.schedule("snooze-old", "17 * * * *", snoozeOldNow);
  settings.onChange((next) => {
    if ((next.snoozeOldThreads ?? 3) >= 1) void snoozeOldNow();
  });

  /** Wakes the due snoozes, marked unread, and returns the next wake time. */
  async function wakeDue() {
    const now = Date.now();
    let next = Infinity;
    for (const [threadId, { until }] of Object.entries(await load())) {
      if (until <= now) await wake(threadId, true);
      else next = Math.min(next, until);
    }
    return next;
  }

  // Starts with the wakes missed while BB was not running.
  bb.background.service("snooze-wake", {
    async start(signal) {
      while (!signal.aborted) {
        const next = await serial(wakeDue);
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wakeTimer = () => {};
            resolve();
          };
          const timer = setTimeout(
            done,
            Math.min(next - Date.now(), MAX_SLEEP),
          );
          signal.addEventListener("abort", done);
          wakeTimer = done;
        });
      }
    },
  });
}
