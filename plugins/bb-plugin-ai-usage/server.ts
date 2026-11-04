// The server entry: one view of ai-usage per BB machine, shared by every
// window. It asks the host entry for the machine's ai-usage and its report,
// keeps the last report in memory, and runs the long operations as jobs.
// It never logs the team key or what a report says.
import { createHash } from "node:crypto";
import type { BbPluginApi, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import demoTeam from "./demo/team.json" with { type: "json" };
import { allowed } from "./src/args.js";
import { hostContract, hostSignals, type MeasuredUsage, type Probe, type RunOutput } from "./src/contract.js";
import { inviteMessage } from "./src/invite.js";
import { teamSource, type TeamSource } from "./src/team-source.js";
import { BusyError, Jobs } from "./src/jobs.js";
import { withDeadline } from "./src/deadline.js";
import { autoInstallable, installRefusal, NOTHING_COLLECTED, phaseOf, type HostFacts } from "./src/phase.js";
import { fillMatrixFromBurn } from "./src/burn-matrix.js";
import { machineInMatrix, mergeMeasured } from "./src/local-providers.js";
import { readReport, SchemaError, type Report } from "./src/report.js";
import { readTaken } from "./src/take.js";
import { rpcContract, type HostView, type JobKind, type JobView } from "./src/rpc.js";

const REPORT_TTL = 30_000;
const PROBE_TTL = 5 * 60_000;
const HOSTS_TTL = 30_000;
const MINUTE = 60_000;
const TIMEOUT = {
  report: 45_000,
  probe: 90_000,
  short: 60_000,
  collect: 10 * MINUTE,
  join: 4 * MINUTE,
  update: 15 * MINUTE,
  app: 5 * MINUTE,
  uninstall: 5 * MINUTE,
  install: 30 * MINUTE,
};

interface HostRecord {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  type: "persistent" | "ephemeral";
}

interface Cache {
  probe: Probe | null;
  probedAt: number;
  probing: Promise<Probe | null> | null;
  probeError: string | null;
  report: Report | null;
  hash: string | null;
  reportAt: number | null;
  reportCheckedAt: number;
  reportState: HostFacts["report"];
  refreshing: Promise<void> | null;
}

interface AutoRecord {
  at: number;
  outcome: "adopted" | "installing" | "installed" | "failed" | "unsupported";
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const caches = new Map<string, Cache>();
  let hostList: { at: number; hosts: HostRecord[]; primaryId: string | null; primaryPlatform: string | null } | null = null;

  const jobs = new Jobs({
    changed: (job) => {
      bb.realtime.publish("job", { id: job.id, hostId: job.hostId, kind: job.kind, status: job.status });
      bb.realtime.publish("changed", { hostId: job.hostId });
    },
    line: (job, line) => bb.realtime.publish("job", { id: job.id, hostId: job.hostId, kind: job.kind, status: job.status, line }),
  });

  host.experimental_onSignal("installLog", ({ payload }) => jobs.append(payload.jobId, payload.line));

  const cache = (hostId: string): Cache => {
    let c = caches.get(hostId);
    if (c === undefined) {
      c = { probe: null, probedAt: 0, probing: null, probeError: null, report: null, hash: null, reportAt: null, reportCheckedAt: 0, reportState: null, refreshing: null };
      caches.set(hostId, c);
    }
    return c;
  };

  async function hosts(force = false) {
    if (!force && hostList !== null && Date.now() - hostList.at < HOSTS_TTL) return hostList;
    const [config, list] = await Promise.all([bb.sdk.system.config(), bb.sdk.hosts.list()]);
    hostList = {
      at: Date.now(),
      hosts: list.map((h) => ({ id: h.id, name: h.name, status: h.status, type: h.type })),
      primaryId: config.primaryHostId,
      primaryPlatform: config.primaryHostPlatform,
    };
    return hostList;
  }

  async function resolve(hostId: string | null): Promise<{ record: HostRecord | null; id: string | null; bbPlatform: string | null }> {
    const h = await hosts();
    const id = hostId ?? h.primaryId;
    const record = h.hosts.find((x) => x.id === id) ?? null;
    return { record, id, bbPlatform: id === h.primaryId ? h.primaryPlatform : null };
  }

  /** The name BB gives a machine, for messages. */
  function labelOf(hostId: string): string {
    return hostList?.hosts.find((x) => x.id === hostId)?.name ?? hostId;
  }

  /**
   * Calls a machine with a hard limit: the host call's own timeout plus slack. A machine that stops
   * answering rejects here, so the work waiting on it always ends and clears its in-flight flag.
   */
  function callHost(method: Parameters<typeof host.call>[0], input: Parameters<typeof host.call>[1], opts: { hostId: string; timeoutMs: number }): Promise<any> {
    const label = labelOf(opts.hostId);
    const started = Date.now();
    const work = host.call(method, input, opts).then(
      (value) => {
        const took = Date.now() - started;
        if (took > 10_000) bb.log.info(`${method} on ${label} took ${Math.round(took / 1000)} s`);
        return value;
      },
      (error: unknown) => {
        bb.log.warn(`${method} on ${label} failed after ${Math.round((Date.now() - started) / 1000)} s: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      },
    );
    return withDeadline(work, opts.timeoutMs + 5_000, label);
  }

  function probeHost(hostId: string, force = false): Promise<Probe | null> {
    const c = cache(hostId);
    if (!force && c.probe !== null && Date.now() - c.probedAt < PROBE_TTL) return Promise.resolve(c.probe);
    if (c.probing !== null) return c.probing;
    c.probing = callHost("probe", {}, { hostId, timeoutMs: TIMEOUT.probe })
      .then((p: Probe) => {
        c.probe = p;
        c.probedAt = Date.now();
        c.probeError = null;
        return p;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        c.probeError = message;
        bb.log.warn(`probe of ${hostId} failed: ${message}`);
        return c.probe;
      })
      .finally(() => {
        c.probing = null;
        bb.realtime.publish("changed", { hostId });
      });
    return c.probing;
  }

  function run(hostId: string, probe: Probe, args: string[], timeoutMs: number, opts: { stdin?: string; json?: boolean } = {}): Promise<RunOutput> {
    if (probe.bin === null) throw new Error("ai-usage is not installed on this machine");
    return callHost(
      "run",
      { bin: probe.bin, aiHome: probe.aiHome, args, stdin: opts.stdin ?? null, json: opts.json ?? false, timeoutMs },
      { hostId, timeoutMs: timeoutMs + 15_000 },
    );
  }

  /** Takes a report: from report --json, collect --json, or nothing when the command failed. */
  function take(hostId: string, out: RunOutput): void {
    const c = cache(hostId);
    c.reportCheckedAt = Date.now();
    if (out.code === 0 && out.json !== null) {
      try {
        const report = readTaken(out.json);
        const hash = createHash("sha256").update(JSON.stringify(report)).digest("hex").slice(0, 32);
        c.reportState = { ok: true, schemaMismatch: false, nothingCollected: false, error: null };
        if (hash !== c.hash) {
          c.report = report;
          c.hash = hash;
          c.reportAt = Date.now();
        }
      } catch (error) {
        c.reportState = {
          ok: false,
          schemaMismatch: error instanceof SchemaError,
          nothingCollected: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      c.reportState = {
        ok: false,
        schemaMismatch: false,
        nothingCollected: out.message.includes(NOTHING_COLLECTED),
        error: out.message || "ai-usage printed no report",
      };
    }
    bb.realtime.publish("changed", { hostId });
  }

  /** A machine's logins and row as they were at its last live reading, kept so it still shows when offline. */
  interface Snapshot {
    at: number;
    name: string;
    /** The machine's own OS hostname, which its ai-usage reports rows under. */
    alias: string;
    user: string;
    providers: MeasuredUsage["providers"];
  }

  /**
   * Adds every persistent machine to the report: its logins, its matrix row and
   * its burn. The work runs on a copy that then replaces the cached report, so a
   * `state` read never sees a half-filled one. A machine that is offline or whose
   * live reading failed shows its last snapshot, marked with when it was seen.
   */
  async function attachMachines(reportHostId: string): Promise<void> {
    const base = cache(reportHostId).report;
    if (base === null) return;
    const list = await hosts(true);
    const persistent = list.hosts.filter((x) => x.type === "persistent");
    const live = await Promise.all(
      persistent
        .filter((machine) => machine.status === "connected")
        .map(async (machine) => {
          try {
            const measured = await callHost("extras", {}, { hostId: machine.id, timeoutMs: 30_000 });
            await bb.storage.kv.set(`snapshot:${machine.id}`, { at: Date.now(), name: machine.name, alias: measured.hostName, user: measured.user, providers: measured.providers } satisfies Snapshot);
            return { id: machine.id, measured };
          } catch (error) {
            bb.log.warn(`extras on ${machine.name} failed: ${error instanceof Error ? error.message : String(error)}`);
            return { id: machine.id, measured: null };
          }
        }),
    );
    const next = structuredClone(base);
    for (const machine of persistent) {
      const reading = live.find((x) => x.id === machine.id)?.measured ?? null;
      const snap = reading === null ? await bb.storage.kv.get<Snapshot>(`snapshot:${machine.id}`) : undefined;
      if (reading !== null) mergeMeasured(next, { ...reading, hostName: machine.name });
      else if (snap !== undefined) mergeMeasured(next, { ...snap, hostName: machine.name }, { measuredAt: snap.at });
      // The row does not depend on extras: its OS user comes from the live reading, the snapshot, or the probe.
      let user = reading?.user ?? snap?.user ?? "";
      if (user === "" && machine.status === "connected") user = cache(machine.id).probe?.user ?? (await probeHost(machine.id))?.user ?? "";
      machineInMatrix(next, machine.name, user, machine.id, [reading?.hostName ?? snap?.alias ?? ""]);
    }
    try {
      fillMatrixFromBurn(next, bb.server.experimental_dataDir, Date.now(), list.hosts.map((h) => ({ id: h.id, name: h.name })));
    } catch (error) {
      bb.log.warn(`burn tokens failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stored = cache(reportHostId);
    stored.report = next;
    stored.hash = createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 32);
    stored.reportAt = Date.now();
  }

  /** Reads the machine's report again, once at a time; every window shares the answer. */
  function refresh(hostId: string): Promise<void> {
    const c = cache(hostId);
    if (c.refreshing !== null) return c.refreshing;
    bb.log.info(`refresh of ${labelOf(hostId)} started`);
    c.refreshing = (async () => {
      const probe = await probeHost(hostId);
      if (probe === null || probe.bin === null) return;
      take(hostId, await run(hostId, probe, ["report", "--json"], TIMEOUT.report, { json: true }));
      await attachMachines(hostId);
    })()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        c.reportCheckedAt = Date.now();
        c.reportState = { ok: false, schemaMismatch: false, nothingCollected: false, error: message };
        bb.log.warn(`report of ${hostId} failed: ${message}`);
      })
      .finally(() => {
        c.refreshing = null;
        bb.log.info(`refresh of ${labelOf(hostId)} finished`);
        bb.realtime.publish("changed", { hostId });
      });
    return c.refreshing;
  }

  async function facts(hostId: string | null): Promise<{ id: string | null; record: HostRecord | null; f: HostFacts }> {
    const { record, id, bbPlatform } = await resolve(hostId);
    const c = id === null ? null : cache(id);
    return {
      id,
      record,
      f: {
        host: record === null ? null : { status: record.status, type: record.type },
        bbPlatform,
        probe: c?.probe ?? null,
        probeError: c?.probeError ?? null,
        job: id === null ? null : jobs.latest(id),
        report: c?.reportState ?? null,
      },
    };
  }

  async function view(hostId: string | null): Promise<HostView> {
    const { id, record, f } = await facts(hostId);
    const p = f.probe;
    const status = p?.status as { install?: { method?: string; schedule?: { state?: string } } } | null | undefined;
    const report = id === null ? null : cache(id).report;
    const auto = id === null ? null : await bb.storage.kv.get<AutoRecord>(`auto:${id}`);
    return {
      hostId: id,
      hostName: record?.name ?? null,
      phase: phaseOf(f),
      platform: p?.platform ?? f.bbPlatform,
      macos: p?.macos ?? null,
      root: p?.uid === 0,
      user: p?.user ?? null,
      version: p?.version ?? null,
      method: status?.install?.method ?? report?.collector.update.method ?? null,
      schedule: status?.install?.schedule?.state ?? null,
      canUninstall: p?.canUninstall ?? false,
      app: p?.app ?? false,
      scheduleEntry: p?.scheduleEntry ?? false,
      auto: auto?.outcome === "installing" || auto?.outcome === "installed" || auto?.outcome === "failed",
      error: f.report?.error ?? p?.error ?? f.probeError ?? null,
    };
  }

  /** Throws for another plugin: these methods hand out the key and what the team uses. */
  function guard(context: ExperimentalPluginRpcHandlerContext) {
    const caller = context.experimental_caller;
    if (caller.kind === "plugin" && caller.pluginId !== bb.pluginId) throw new Error("AI Usage answers its own windows only");
  }

  async function target(hostId: string | null): Promise<{ id: string; probe: Probe }> {
    const { id, record } = await resolve(hostId);
    if (id === null || record === null) throw new Error("BB has no such machine");
    const probe = await probeHost(id);
    if (probe === null) throw new Error(`${record.name} did not answer`);
    return { id, probe };
  }

  function startJob(hostId: string, kind: JobKind, work: (job: JobView, log: (line: string) => void) => Promise<string>): string {
    try {
      return jobs.start(hostId, kind, work).id;
    } catch (error) {
      if (error instanceof BusyError) throw new Error(error.message);
      throw error;
    }
  }

  /** A run's answer, or its error thrown. */
  function check(out: RunOutput): string {
    if (out.code !== 0) throw new Error(out.message || "ai-usage failed");
    return out.stdout.trim();
  }

  async function collect(hostId: string, probe: Probe, log: (line: string) => void): Promise<string> {
    log("collecting: reading the tools' logs, asking each tool for its quota, and reading the team");
    const out = await run(hostId, probe, ["collect", "--json"], TIMEOUT.collect, { json: true });
    if (out.code !== 0) throw new Error(out.message || "the run failed");
    take(hostId, out);
    await probeHost(hostId, true);
    await attachMachines(hostId);
    return "collected";
  }

  async function record(hostId: string, outcome: AutoRecord["outcome"]) {
    await bb.storage.kv.set(`auto:${hostId}`, { at: Date.now(), outcome } satisfies AutoRecord);
  }

  function install(hostId: string, teamKey: string | null, relay: string | null, auto: boolean): string {
    return startJob(hostId, "install", async (job, log) => {
      if (auto) await record(hostId, "installing");
      try {
        const out = await callHost("install", { jobId: job.id, teamKey, relay }, { hostId, timeoutMs: TIMEOUT.install });
        if (!out.ok) throw new Error(out.message);
        await record(hostId, "installed");
        bb.log.info(`installed ai-usage ${out.tag ?? ""} on ${hostId}`);
        log(out.message);
        return out.message;
      } catch (error) {
        await record(hostId, "failed");
        throw error;
      } finally {
        await probeHost(hostId, true);
        void refresh(hostId);
      }
    });
  }

  /** The team key and relay of the first machine that runs ai-usage, read into memory only. */
  async function sourceTeam(except: string): Promise<TeamSource | null> {
    const h = await hosts();
    const connected = new Set(h.hosts.filter((x) => x.status === "connected").map((x) => x.id));
    const order = [...new Set([h.primaryId, ...h.hosts.map((x) => x.id)])].filter((x): x is string => x !== null && x !== except && connected.has(x));
    return teamSource(order, {
      hasAiUsage: async (id) => (await probeHost(id))?.bin != null,
      collected: async (id) => {
        if (cache(id).reportState?.ok !== true) await refresh(id);
        return cache(id).reportState?.ok === true;
      },
      key: async (id) => check(await run(id, (await probeHost(id))!, ["team", "key"], TIMEOUT.short)),
      relay: async (id) => {
        const p = (await probeHost(id))!;
        return callHost("relay", { bin: p.bin!, aiHome: p.aiHome }, { hostId: id, timeoutMs: TIMEOUT.short });
      },
    });
  }

  // Installs ai-usage on the primary machine when the plugin starts and the
  // machine has none, once per machine. A machine that already has it is
  // recorded too, so removing ai-usage from it later does not bring it back.
  async function autoInstall(signal: AbortSignal): Promise<boolean> {
    const h = await hosts(true);
    if (h.primaryId === null) return false;
    const id = h.primaryId;
    const recorded = (await bb.storage.kv.get<AutoRecord>(`auto:${id}`)) !== undefined;
    if (recorded) return true;
    const probe = await probeHost(id, true);
    if (signal.aborted || probe === null) return false;
    const { f } = await facts(id);
    if (autoInstallable(f, false)) {
      bb.log.info(`no ai-usage on ${id}: installing it`);
      install(id, null, null, true);
      return true;
    }
    if (probe.bin !== null) {
      await record(id, "adopted");
      void refresh(id);
      return true;
    }
    if (f.host?.status === "connected") {
      await record(id, "unsupported");
      return true;
    }
    return false;
  }

  bb.background.service("auto-install", {
    async start(signal) {
      // The primary machine may connect after the server starts.
      for (let attempt = 0; attempt < 30 && !signal.aborted; attempt++) {
        try {
          if (await autoInstall(signal)) return;
        } catch (error) {
          bb.log.warn(`auto-install check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 2 * MINUTE);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            done();
          }, { once: true });
        });
      }
    },
  });

  const demo = readReport(demoTeam);

  bb.rpc.register(rpcContract, {
    state: async ({ hostId, hash }, context) => {
      guard(context);
      const { id } = await resolve(hostId);
      if (id !== null) {
        const c = cache(id);
        if (c.probe === null || Date.now() - c.probedAt > PROBE_TTL) void probeHost(id);
        if (Date.now() - c.reportCheckedAt > REPORT_TTL) void refresh(id);
      }
      const c = id === null ? null : cache(id);
      return {
        view: await view(hostId),
        job: id === null ? null : jobs.latest(id),
        report: c !== null && c.hash !== hash ? c.report : null,
        hash: c?.hash ?? null,
        reportAt: c?.reportAt ?? null,
        refreshing: c?.refreshing != null || c?.probing != null,
      };
    },
    machines: async (_input, context) => {
      guard(context);
      const h = await hosts(true);
      const persistent = h.hosts.filter((x) => x.type === "persistent");
      await Promise.all(persistent.filter((x) => x.status === "connected").map((x) => probeHost(x.id)));
      const machines = [];
      for (const x of persistent) {
        const v = await view(x.id);
        machines.push({
          id: x.id,
          name: x.name,
          primary: x.id === h.primaryId,
          connected: x.status === "connected",
          phase: v.phase,
          platform: v.platform,
          user: v.user,
          root: v.root,
          version: v.version,
          scheduleEntry: v.scheduleEntry,
          job: jobs.latest(x.id),
        });
      }
      return { machines };
    },
    demo: async (_input, context) => {
      guard(context);
      return { report: demo };
    },
    job: async ({ id }, context) => {
      guard(context);
      return { job: jobs.get(id) };
    },
    collect: async ({ hostId }, context) => {
      guard(context);
      const t = await target(hostId);
      return { jobId: startJob(t.id, "collect", (_job, log) => collect(t.id, t.probe, log)) };
    },
    install: async ({ hostId, teamKey, relay, copyTeam }, context) => {
      guard(context);
      const t = await target(hostId);
      const refusal = installRefusal(t.probe);
      if (refusal !== null) throw new Error(refusal);
      let key = teamKey;
      let url = relay;
      if (copyTeam && (key === null || key.trim() === "")) {
        const source = await sourceTeam(t.id);
        key = source?.key ?? null;
        url = url ?? source?.relay ?? null;
      }
      return { jobId: install(t.id, key, url, false) };
    },
    join: async ({ hostId, key, relay }, context) => {
      guard(context);
      const t = await target(hostId);
      return {
        jobId: startJob(t.id, "join", async (_job, log) => {
          if (relay !== null && relay.trim() !== "") {
            check(await run(t.id, t.probe, ["relay", "set", relay.trim()], TIMEOUT.short));
            log("relay set");
          }
          const said = check(await run(t.id, t.probe, ["team", "join"], TIMEOUT.join, { stdin: `${key.trim()}\n` }));
          log(said.split("\n")[0] ?? "joined");
          await collect(t.id, t.probe, log);
          return said.startsWith("already in team") ? "This machine is already in that team." : "Joined the team.";
        }),
      };
    },
    invite: async ({ hostId }, context) => {
      guard(context);
      const t = await target(hostId);
      if (t.probe.bin === null) throw new Error("ai-usage is not installed on this machine");
      // team key on a machine that never collected makes a new team, so ask only once it has.
      if (cache(t.id).reportState?.ok !== true) throw new Error("Invite works once this machine has collected");
      const key = check(await run(t.id, t.probe, ["team", "key"], TIMEOUT.short));
      const relay = await callHost("relay", { bin: t.probe.bin, aiHome: t.probe.aiHome }, { hostId: t.id, timeoutMs: TIMEOUT.short });
      return { message: inviteMessage(key, relay) };
    },
    update: async ({ hostId }, context) => {
      guard(context);
      const t = await target(hostId);
      return {
        jobId: startJob(t.id, "update", async (_job, log) => {
          log("ai-usage update");
          const said = check(await run(t.id, t.probe, ["update"], TIMEOUT.update));
          const p = await probeHost(t.id, true);
          if (p !== null) {
            take(t.id, await run(t.id, p, ["report", "--json"], TIMEOUT.report, { json: true }));
            await attachMachines(t.id);
          }
          return said.split("\n").at(-1) ?? "updated";
        }),
      };
    },
    schedule: async ({ hostId, on }, context) => {
      guard(context);
      const t = await target(hostId);
      return {
        jobId: startJob(t.id, on ? "schedule-on" : "schedule-off", async () => {
          const said = check(await run(t.id, t.probe, ["schedule", on ? "install" : "remove"], TIMEOUT.short));
          await probeHost(t.id, true);
          void refresh(t.id);
          return said.split("\n")[0] ?? "";
        }),
      };
    },
    appInstall: async ({ hostId }, context) => {
      guard(context);
      const t = await target(hostId);
      return {
        jobId: startJob(t.id, "app", async () => {
          const said = check(await run(t.id, t.probe, ["app", "install"], TIMEOUT.app));
          await probeHost(t.id, true);
          return said.split("\n").at(-1) ?? "installed the menu bar app";
        }),
      };
    },
    uninstall: async ({ hostId, forget, purge }, context) => {
      guard(context);
      const t = await target(hostId);
      if (!t.probe.canUninstall) throw new Error("This ai-usage has no uninstall: update it first");
      const args = ["uninstall", ...(forget ? ["--forget"] : []), ...(purge ? ["--purge"] : [])];
      return {
        jobId: startJob(t.id, "uninstall", async (_job, log) => {
          const out = await run(t.id, t.probe, args, TIMEOUT.uninstall);
          for (const line of out.stdout.trim().split("\n")) if (line !== "") log(line);
          const c = cache(t.id);
          c.report = null;
          c.hash = null;
          c.reportState = null;
          await probeHost(t.id, true);
          if (out.code !== 0) throw new Error(out.message || "some steps failed");
          return out.stdout.trim().split("\n").at(-1) ?? "removed";
        }),
      };
    },
    cost: async ({ hostId, args }, context) => {
      guard(context);
      if (args[0] !== "cost" || !allowed(args)) throw new Error("not a cost answer");
      const t = await target(hostId);
      const out = await run(t.id, t.probe, args, TIMEOUT.short);
      if (out.code === 0) void refresh(t.id);
      return { ok: out.code === 0, message: out.code === 0 ? out.stdout.trim() : out.message };
    },
  });

  bb.onDispose(() => {
    caches.clear();
  });
}
