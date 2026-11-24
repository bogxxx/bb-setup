// The server entry: samples every connected machine through the host entry,
// publishes their load, routes the process list and quits to a machine, and
// runs Guard where the server is BB's app on a Mac.
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, rpcContract } from "./contract";
import { createGuard } from "./guard-install";
import { SAMPLE_CHANNEL, type MachineSample, type Machines } from "./shared";

/** While a window watches, each machine is read this often. */
const WATCHED_EVERY_MS = 3000;
/** With no window watching, a reading a minute keeps "last seen" fresh. */
const IDLE_EVERY_MS = 60_000;
/** A window's watch lasts this long; windows renew it while they show. */
const WATCH_MS = 30_000;
/** A machine that takes longer than this to answer counts as failed. */
const SAMPLE_TIMEOUT_MS = 5000;
const MACHINES_TTL_MS = 30_000;
const GUARD_EVERY_MS = 10_000;

type Known = Omit<MachineSample, "sample" | "sampledAt" | "error">;
type Reading = Pick<MachineSample, "sample" | "sampledAt" | "error">;

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    guard: {
      type: "boolean",
      label: "Guard",
      description:
        "Keep BB responsive when the Mac server is overloaded: what BB starts runs at a lower priority, moves to the efficiency cores under load, and Pause all can stop it. macOS only.",
      default: true,
    },
  });
  const guard = createGuard();
  const guardOn = async () => (await settings.get()).guard;

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  let known: { at: number; list: Known[] } | null = null;
  /** BB's persistent machines, the server's own first, then by name. */
  async function machines(force = false): Promise<Known[]> {
    if (!force && known && Date.now() - known.at < MACHINES_TTL_MS)
      return known.list;
    const [config, hosts] = await Promise.all([
      bb.sdk.system.config(),
      bb.sdk.hosts.list(),
    ]);
    const primaryId = config.primaryHostId ?? null;
    const list = hosts
      .filter((h) => h.type === "persistent")
      .map((h) => ({
        id: h.id,
        name: h.name,
        primary: h.id === primaryId,
        connected: h.status === "connected",
        lastSeenAt: h.lastSeenAt ?? null,
      }))
      .sort(
        (a, b) =>
          Number(b.primary) - Number(a.primary) ||
          Number(b.connected) - Number(a.connected) ||
          a.name.localeCompare(b.name),
      );
    known = { at: Date.now(), list };
    return list;
  }

  const readings = new Map<string, Reading>();
  let watchedUntil = 0;
  let wake = new AbortController();

  function snapshot(list: Known[]): Machines {
    return {
      machines: list.map((m) => ({
        ...m,
        ...(readings.get(m.id) ?? { sample: null, sampledAt: null, error: null }),
      })),
    };
  }

  /** Reads one machine; a failure keeps its last sample and says why. */
  async function read(machine: Known) {
    try {
      const sample = await host.call(
        "sample",
        {},
        { hostId: machine.id, timeoutMs: SAMPLE_TIMEOUT_MS },
      );
      if (machine.primary) sample.guard = guard.supported;
      readings.set(machine.id, { sample, sampledAt: Date.now(), error: null });
    } catch (cause) {
      const previous = readings.get(machine.id);
      readings.set(machine.id, {
        sample: previous?.sample ?? null,
        sampledAt: previous?.sampledAt ?? null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  bb.rpc.register(rpcContract, {
    async machines() {
      return snapshot(await machines());
    },
    watch() {
      const idle = Date.now() > watchedUntil;
      watchedUntil = Date.now() + WATCH_MS;
      // Coming back from idle: read now instead of within the minute.
      if (idle) wake.abort();
      return null;
    },
    async listProcesses({ hostId }) {
      await assertKnown(hostId);
      return host.call("listProcesses", {}, { hostId, timeoutMs: 30_000 });
    },
    async quitProcesses({ hostId, pids, force }) {
      await assertKnown(hostId);
      return host.call(
        "quitProcesses",
        { pids, force },
        { hostId, timeoutMs: 60_000 },
      );
    },
    guardStatus: async () => guard.info(await guardOn()),
    async setPauseAll({ paused }) {
      const on = await guardOn();
      // Resume all always works, so nothing stays stopped.
      if (paused && !(on && guard.supported)) throw new Error("Guard is off.");
      return guard.setPauseAll(paused, on);
    },
  });

  /** Only a persistent machine BB knows takes calls from the page. */
  async function assertKnown(hostId: string) {
    if (!(await machines()).some((m) => m.id === hostId))
      throw new Error("BB doesn't know this machine.");
  }

  bb.background.service("sampler", {
    async start(signal) {
      while (!signal.aborted) {
        const list = await machines().catch(() => known?.list ?? []);
        // Machines read at once, so a slow one holds up no other.
        await Promise.all(list.filter((m) => m.connected).map(read));
        if (signal.aborted) return;
        bb.realtime.publish(SAMPLE_CHANNEL, snapshot(list));
        wake = new AbortController();
        const every = Date.now() < watchedUntil ? WATCHED_EVERY_MS : IDLE_EVERY_MS;
        await sleep(every, undefined, {
          signal: AbortSignal.any([signal, wake.signal]),
        }).catch(() => {});
      }
    },
  });

  if (!guard.supported) return;
  // The guard runs under launchd, apart from BB: a reload leaves it running.
  let changed = new AbortController();
  settings.onChange(() => changed.abort());
  bb.background.service("guard", {
    async start(signal) {
      let lastError = "";
      while (!signal.aborted) {
        changed = new AbortController();
        try {
          await guard.apply(await guardOn());
          lastError = "";
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          if (message !== lastError) bb.log.warn(`Guard: ${message}`);
          lastError = message;
        }
        const wakeGuard = AbortSignal.any([signal, changed.signal]);
        await sleep(GUARD_EVERY_MS, null, { signal: wakeGuard }).catch(() => {});
      }
    },
  });
}
