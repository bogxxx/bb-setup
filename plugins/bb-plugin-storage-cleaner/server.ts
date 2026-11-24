// The server entry: the settings, the nightly schedule, and the page's RPC.
// Each machine scans and cleans itself through the host entry; the server
// tells it what only BB knows, its threads, and routes the page's calls.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, rpcContract, type ThreadRow } from "./contract";
import { CHANGED, type Machine, type Outcome } from "./shared";

const STALE_DAYS = 7;
/** Long cleanups and waited-for scans may take this long on a machine. */
const LONG = 30 * 60_000;
const THREADS_TTL = 10_000;
const MACHINES_TTL = 30_000;

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    nightlyScan: {
      type: "boolean",
      label: "Nightly scan",
      description: "00:00 UTC, on every connected machine",
      default: true,
    },
    cleanArchivedThreads: {
      type: "boolean",
      label: "Clean stale archived threads",
      description: "Archived 7+ days ago",
      default: false,
    },
    cleanLeftoverWorktrees: {
      type: "boolean",
      label: "Clean leftover worktrees",
      description: "Thread archived or deleted",
      default: false,
    },
    cleanDevCaches: {
      type: "boolean",
      label: "Clean stale dev caches",
      description: "Untouched for 7+ days",
      default: false,
    },
    cleanTrash: {
      type: "boolean",
      label: "Clean Trash",
      description: "Every night",
      default: false,
    },
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });
  host.experimental_onSignal("changed", ({ hostId }) =>
    bb.realtime.publish(CHANGED, { hostId }),
  );
  host.experimental_onWorkerExit(({ hostId }) =>
    bb.realtime.publish(CHANGED, { hostId }),
  );

  let machineList: {
    at: number;
    machines: Machine[];
    primaryId: string | null;
  } | null = null;
  /** BB's persistent machines, the server's own first. */
  async function machines(force = false) {
    if (!force && machineList && Date.now() - machineList.at < MACHINES_TTL)
      return machineList;
    const [config, list] = await Promise.all([
      bb.sdk.system.config(),
      bb.sdk.hosts.list(),
    ]);
    const primaryId = config.primaryHostId ?? null;
    const out = list
      .filter((h) => h.type === "persistent")
      .map((h) => ({
        id: h.id,
        name: h.name,
        connected: h.status === "connected",
        primary: h.id === primaryId,
      }))
      .sort(
        (a, b) =>
          Number(b.primary) - Number(a.primary) ||
          Number(b.connected) - Number(a.connected) ||
          a.name.localeCompare(b.name),
      );
    machineList = { at: Date.now(), machines: out, primaryId };
    return machineList;
  }

  let threadCache: {
    at: number;
    rows: ThreadRow[];
    ids: Set<string>;
    inUse: string[];
  } | null = null;
  /** Every thread, archived ones too, and the workspaces live threads use. */
  async function threads() {
    if (threadCache && Date.now() - threadCache.at < THREADS_TTL)
      return threadCache;
    const projects = new Map<string, string>();
    for (const project of await bb.sdk.projects.list({ includePersonal: true }))
      projects.set(project.id, project.name);
    const rows: ThreadRow[] = [];
    const inUse: string[] = [];
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 200) {
        const page = await bb.sdk.threads.list({
          archived,
          includeHidden: true,
          limit: 200,
          offset,
        });
        for (const t of page) {
          rows.push([
            t.id,
            (t.title ?? t.titleFallback ?? t.id).trim().slice(0, 2000),
            (projects.get(t.projectId) ?? "").slice(0, 2000),
            t.archivedAt ?? null,
          ]);
          if (!t.archivedAt && t.environmentPath) inUse.push(t.environmentPath);
        }
        if (page.length < 200) break;
      }
    }
    threadCache = {
      at: Date.now(),
      rows,
      ids: new Set(rows.map(([id]) => id)),
      inUse,
    };
    return threadCache;
  }

  async function known() {
    const { rows, inUse } = await threads();
    return { threads: rows, inUse };
  }

  /** A machine the page may ask for: a persistent one BB knows. */
  async function machine(hostId: string) {
    const found = (await machines()).machines.find((m) => m.id === hostId);
    if (!found) throw new Error("BB doesn't know this machine.");
    return found;
  }

  /**
   * Threads whose folders the machine keeps but BB no longer lists, which BB
   * then reports as not found. Any other failure keeps the folders.
   */
  async function goneThreads(hostId: string) {
    const { ids } = await host.call("bbThreadIds", {}, { hostId });
    const listed = (await threads()).ids;
    const gone: string[] = [];
    for (const threadId of ids) {
      if (listed.has(threadId)) continue;
      const missing = await bb.sdk.threads.get({ threadId }).then(
        () => false,
        (cause: unknown) =>
          /not found|404/i.test(
            cause instanceof Error ? cause.message : String(cause),
          ),
      );
      if (missing) gone.push(threadId);
    }
    return gone;
  }

  async function clean(
    hostId: string,
    target: "bb" | "dev" | "trash",
    what: { threads: boolean; worktrees: boolean; staleDays: number | null },
  ): Promise<Outcome> {
    const gone = target === "bb" ? await goneThreads(hostId) : [];
    return host.call(
      "clean",
      {
        ...(await known()),
        target,
        gone,
        bbThreads: what.threads,
        bbWorktrees: what.worktrees,
        staleDays: what.staleDays,
      },
      { hostId, timeoutMs: LONG },
    );
  }

  const message = (cause: unknown) =>
    cause instanceof Error ? cause.message : String(cause);

  bb.rpc.register(rpcContract, {
    async storageMachines() {
      const { machines: list, primaryId } = await machines(true);
      return { machines: list, primaryId };
    },
    async storageSnapshot({ hostId }) {
      const found = await machine(hostId);
      if (!found.connected)
        return {
          snapshot: null,
          error: `${found.name} is offline. Its scan shows when it connects.`,
        };
      try {
        const snapshot = await host.call("snapshot", await known(), {
          hostId,
          timeoutMs: 120_000,
        });
        return { snapshot, error: null };
      } catch (cause) {
        bb.log.warn(`snapshot on ${found.name} failed: ${message(cause)}`);
        return {
          snapshot: null,
          error: `Couldn't read ${found.name}: ${message(cause)}`,
        };
      }
    },
    async storageFolder({ hostId, path }) {
      await machine(hostId);
      return host.call(
        "folder",
        { ...(await known()), path },
        { hostId, timeoutMs: 60_000 },
      );
    },
    async storageRescan({ hostId }) {
      await machine(hostId);
      await host.call("rescan", { wait: false }, { hostId });
      return null;
    },
    async storageOpenFullDiskAccess({ hostId }) {
      await machine(hostId);
      await host.call("openFullDiskAccess", {}, { hostId });
      return null;
    },
    async storageDelete({ hostId, paths }) {
      await machine(hostId);
      return host.call(
        "delete",
        { ...(await known()), paths },
        { hostId, timeoutMs: LONG },
      );
    },
    async storageClean({ hostId, target }) {
      await machine(hostId);
      return clean(hostId, target, {
        threads: true,
        worktrees: true,
        staleDays: null,
      });
    },
  });

  /** One machine's nightly scan and the cleanups that are on. */
  async function nightly(
    found: Machine,
    on: Awaited<ReturnType<typeof settings.get>>,
  ) {
    const cleans =
      on.cleanArchivedThreads ||
      on.cleanLeftoverWorktrees ||
      on.cleanDevCaches ||
      on.cleanTrash;
    // Cleaning trusts the ages in the scan, so it needs tonight's.
    const scanned = await host.call(
      "rescan",
      { wait: true },
      { hostId: found.id, timeoutMs: LONG },
    );
    if (!scanned.ok || !cleans) return;
    if (on.cleanArchivedThreads || on.cleanLeftoverWorktrees)
      await clean(found.id, "bb", {
        threads: on.cleanArchivedThreads,
        worktrees: on.cleanLeftoverWorktrees,
        staleDays: STALE_DAYS,
      });
    if (on.cleanDevCaches)
      await clean(found.id, "dev", {
        threads: false,
        worktrees: false,
        staleDays: STALE_DAYS,
      });
    if (on.cleanTrash)
      await clean(found.id, "trash", {
        threads: false,
        worktrees: false,
        staleDays: null,
      });
  }

  // Every hour on the hour; the nightly run is the one at 00:00 UTC.
  bb.background.schedule("storageNightly", "0 * * * *", async () => {
    // Once per UTC day: at 00:00, or at the first hour BB is up after it.
    const today = new Date().toISOString().slice(0, 10);
    const last = await bb.storage.kv.get<string>("lastNightly");
    if (last === today) return;
    await bb.storage.kv.set("lastNightly", today);
    if (last === undefined || last === null) return;
    const on = await settings.get();
    const cleans =
      on.cleanArchivedThreads ||
      on.cleanLeftoverWorktrees ||
      on.cleanDevCaches ||
      on.cleanTrash;
    if (!on.nightlyScan && !cleans) return;
    const { machines: list } = await machines(true);
    // Machines scan at once; each one's own work stays in order.
    await Promise.all(
      list
        .filter((m) => m.connected)
        .map((found) =>
          nightly(found, on).catch((cause: unknown) =>
            bb.log.warn(`nightly run on ${found.name} failed: ${message(cause)}`),
          ),
        ),
    );
  });
}
