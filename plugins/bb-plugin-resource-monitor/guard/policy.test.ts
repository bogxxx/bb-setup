import { describe, expect, it } from "vitest";
import { guardStatusSchema } from "../shared";
import {
  classify,
  decide,
  newState,
  release,
  settle,
  statusOf,
  toSaved,
  type Action,
  type Proc,
} from "./policy.mjs";

const APP = "/Applications/bb.app",
  BB = `${APP}/Contents/MacOS/bb`,
  DIST = `${APP}/Contents/Resources/x`;
const SERVER = 621,
  DAEMON = 747,
  SELF = 99,
  START = Date.UTC(2026, 9, 22, 12);
const GIT_DIFF = "/usr/bin/git diff --no-ext-diff --numstat";

/** A 10-core Mac in miniature: running processes share the cores, and actions change them. */
class Mac {
  now = START;
  procs = new Map<number, Proc & { rate: number; ignoresTerm?: boolean }>();
  s = newState({}, 0);
  pauseAll = false;
  log: Action[] = [];
  private next = 1000;
  constructor() {
    this.add({ pid: 1, ppid: 0, args: "/sbin/launchd" });
    this.add({ pid: 401, ppid: 1, args: BB });
    this.add({
      pid: SERVER,
      ppid: 401,
      args: `${BB} ${DIST}/server/dist/index.js`,
    });
    this.add({
      pid: DAEMON,
      ppid: 401,
      args: `${BB} ${DIST}/host-daemon/dist/daemon-bundle.mjs`,
    });
    this.add({ pid: SELF, ppid: 1, args: `${BB} /x/guard.mjs` });
  }
  add(
    p: Partial<Proc> & {
      ppid: number;
      args: string;
      rate?: number;
      ignoresTerm?: boolean;
    },
  ) {
    const pid = p.pid ?? this.next++;
    this.procs.set(pid, {
      pid,
      nice: 0,
      stat: "S",
      cpu: 0,
      startedAt: this.now,
      tty: "??",
      rate: 0,
      ...p,
    });
    return pid;
  }
  remove(pid: number) {
    this.procs.delete(pid);
    for (const p of this.procs.values()) if (p.ppid === pid) p.ppid = 1;
  }
  /** An agent CLI under its per-thread wrapper. */
  agent(rate = 5) {
    const wrapper = this.add({
      ppid: DAEMON,
      args: `${BB} ${DIST}/host-daemon/dist/bb-provider-bridge-worker.mjs`,
    });
    return this.add({ ppid: wrapper, args: "claude --verbose", rate });
  }
  tick(count = 1) {
    for (let i = 0; i < count; i += 1) {
      const running = [...this.procs.values()].filter(
        (p) => !p.stat.includes("T"),
      );
      const demand = running.reduce((sum, p) => sum + p.rate, 0),
        share = Math.min(1, 1000 / Math.max(1, demand));
      for (const p of running) p.cpu += (p.rate * share * 2) / 100;
      this.now += 2000;
      const input = {
        app: APP,
        self: SELF,
        pauseAll: this.pauseAll,
        busy: (demand * share) / 10,
      };
      const acts = decide([...this.procs.values()], this.s, input, this.now);
      for (const a of acts) {
        const p = this.procs.get(a.pid);
        if (p && a.type === "nice") p.nice = 10;
        if (p && (a.type === "stop" || a.type === "cont"))
          p.stat = a.type === "stop" ? "T" : "S";
        if (p && (a.type === "kill" || (a.type === "term" && !p.ignoresTerm)))
          this.remove(a.pid);
        settle(this.s, a, null, this.now);
      }
      this.log.push(...acts);
    }
    return this;
  }
  of = (type: Action["type"]) =>
    this.log.filter((a) => a.type === type).map((a) => a.pid);
  messages = () => this.s.events.map((e) => e.message);
}

describe("policy", () => {
  it("tells BB, what it started, and everything else apart", () => {
    const mac = new Mac();
    const claude = mac.agent();
    const tool = mac.add({ ppid: claude, args: "/bin/zsh -c make" });
    const esbuild = mac.add({ ppid: SERVER, args: "/x/esbuild --service" });
    const terminal = mac.add({ ppid: DAEMON, args: "-zsh", tty: "ttys003" });
    const ps = mac.add({ ppid: SELF, args: "/bin/ps" });
    const app = mac.add({ ppid: 1, args: "/Applications/Safari.app/x" });
    const young = mac.add({ ppid: DAEMON, args: "(git)" });
    mac.add({ pid: 7, ppid: 8, args: "/x" });
    mac.add({ pid: 8, ppid: 7, args: "/y" });
    const kinds = classify([...mac.procs.values()], APP, SELF);
    const say = (pid: number) => {
      const k = kinds.get(pid) ?? null;
      return k && k !== "core"
        ? `${k.direct ? "direct" : "deep"}${k.helper ? " helper" : ""}`
        : k;
    };
    expect(
      [
        1,
        401,
        DAEMON,
        SELF,
        ps,
        app,
        young,
        7,
        claude,
        tool,
        esbuild,
        terminal,
      ].map(say),
    ).toEqual([
      null,
      "core",
      "core",
      null,
      null,
      null,
      null,
      null,
      "direct",
      "deep",
      "direct helper",
      "direct",
    ]);
  });

  it("lowers what BB started once it was seen twice, and never lowers a nice value", () => {
    const mac = new Mac();
    const claude = mac.agent();
    const nicer = mac.add({ ppid: claude, args: "/usr/bin/yes", nice: 15 });
    expect(mac.tick().log).toEqual([]);
    expect(mac.tick(5).of("nice")).toEqual([claude]);
    expect(mac.procs.get(nicer)?.nice).toBe(15);
  });

  it("moves busy processes to efficiency cores in an overload, and back when it ends", () => {
    const mac = new Mac();
    const claude = mac.agent();
    const build = mac.add({ ppid: claude, args: "/usr/bin/cc", rate: 300 });
    const app = mac.add({
      ppid: 1,
      args: "/Applications/Xcode.app/x",
      rate: 600,
    });
    expect([mac.tick(3).s.overload, mac.tick().s.overload]).toEqual([
      false,
      true,
    ]);
    expect(mac.messages()).toEqual([
      "Overload: busy processes BB started run on efficiency cores",
    ]);
    expect(mac.of("bg")).toEqual([build]);
    expect(guardStatusSchema.parse(statusOf(mac.s, mac.now))).toMatchObject({
      mode: "overload",
      counts: { background: 1, paused: 0 },
    });
    mac.procs.get(app)!.rate = 450; // 75 %: not calm yet.
    expect(mac.tick(20).s.overload).toBe(true);
    mac.procs.get(app)!.rate = 100;
    expect([mac.tick(10).s.overload, mac.tick().s.overload]).toEqual([
      true,
      false,
    ]);
    expect([mac.of("unbg"), mac.messages().at(-1)]).toEqual([
      [build],
      "Overload over",
    ]);
  });

  it("stops BB's leaking git diff (the 2026-10-22 incident), and touches nothing else", () => {
    // A new copy every 6 s, each wanting 65 % of a core, on a Mac already 90 % busy.
    const mac = new Mac();
    mac.add({ ppid: 1, args: "/Applications/Xcode.app/x", rate: 900 });
    mac.add({ ppid: SELF, args: "/bin/ps", rate: 50 });
    for (let i = 0; i < 4; i += 1)
      mac.add({
        ppid: 1,
        args: GIT_DIFF,
        rate: 65,
        cpu: 30,
        startedAt: START - 60e3,
      });
    const gits: number[] = [];
    let most = 0;
    for (let second = 0; second < 600; second += 2) {
      if (second % 6 === 0)
        gits.push(mac.add({ ppid: DAEMON, args: GIT_DIFF, rate: 65 }));
      mac.tick();
      most = Math.max(most, gits.filter((pid) => mac.procs.has(pid)).length);
    }
    expect(mac.of("term").length).toBeGreaterThan(70);
    expect(most).toBeLessThanOrEqual(8); // Without Guard: 100 copies.
    expect(mac.of("nice").length).toBeGreaterThan(70);
    expect(mac.of("bg").length).toBeGreaterThan(70);
    expect(mac.log.filter((a) => !gits.includes(a.pid))).toEqual([]);
    expect(mac.messages().at(-1)).toMatch(
      /^Stopped \d copies of git diff --no-ext-diff --numstat$/u,
    );
  });

  it("sends SIGKILL 5 s after SIGTERM, also when the pile shrank", () => {
    const mac = new Mac();
    const old = {
      ppid: DAEMON,
      args: GIT_DIFF,
      rate: 20,
      cpu: 8,
      startedAt: START - 40e3,
      ignoresTerm: true,
    };
    const pids = [0, 1, 2].map((i) =>
      mac.add({ ...old, startedAt: old.startedAt + i }),
    );
    expect(mac.tick(2).of("term")).toEqual(pids.slice(0, 2));
    mac.remove(pids[2]);
    expect(mac.tick(2).of("kill")).toEqual([]);
    expect(mac.tick().of("kill")).toEqual(pids.slice(0, 2));
  });

  it("leaves alone what is not a pile-up", () => {
    const mac = new Mac();
    const copies = (n: number, ppid: number, args: string, extra = {}) =>
      Array.from({ length: n }, (_, i) =>
        mac.add({
          ppid,
          args,
          rate: 20,
          cpu: 12,
          startedAt: START - 60e3 + i,
          ...extra,
        }),
      );
    copies(2, DAEMON, "/usr/bin/git status");
    copies(3, DAEMON, "/usr/bin/git log", { startedAt: START });
    for (const flag of ["--binary", "--numstat", "--name-status"])
      copies(1, DAEMON, `/usr/bin/git diff ${flag}`);
    for (const pid of copies(3, DAEMON, "/usr/bin/git fetch"))
      mac.add({ ppid: pid, args: "/usr/bin/ssh" });
    copies(3, DAEMON, "/x/esbuild --service", { rate: 0.5, cpu: 0 });
    copies(3, DAEMON, "-zsh", { tty: "ttys001" });
    copies(3, mac.agent(), "/usr/bin/rg x");
    copies(3, 401, `${BB} worker`);
    copies(3, mac.procs.get(mac.agent())!.ppid, "claude --verbose"); // Under one agent wrapper.
    mac.tick(10);
    expect(mac.of("term")).toEqual([]);
  });

  it("pauses all BB started but its helpers, also later processes, and resumes exactly those", () => {
    const mac = new Mac();
    const claude = mac.agent();
    const tool = mac.add({ ppid: claude, args: "/usr/bin/make" });
    const theirs = mac.add({ ppid: claude, args: "/usr/bin/vim", stat: "T" });
    const terminal = mac.add({ ppid: DAEMON, args: "-zsh", tty: "ttys003" });
    const fetch = mac.add({ ppid: SERVER, args: "/usr/bin/git fetch" });
    const helpers = [
      fetch,
      mac.add({ ppid: fetch, args: "/usr/bin/ssh" }),
      mac.add({ ppid: DAEMON, args: GIT_DIFF }),
    ];
    mac.tick(2).pauseAll = true;
    expect(mac.tick().of("stop")).toEqual([claude, tool, terminal]);
    expect(statusOf(mac.s, mac.now)).toMatchObject({
      mode: "paused",
      counts: { paused: 3 },
    });
    const later = mac.add({ ppid: claude, args: "/usr/bin/git status" });
    expect(mac.tick(2).of("stop")).toContain(later);
    mac.pauseAll = false;
    expect(mac.tick().of("cont")).toEqual([claude, tool, terminal, later]);
    expect(mac.messages()).toEqual([
      "Paused 3 processes",
      "Resumed 4 processes",
    ]);
    expect(
      [theirs, ...helpers].some((pid) =>
        mac.log.some((a) => a.pid === pid && a.type !== "nice"),
      ),
    ).toBe(false);
  });

  it("sends SIGCONT before anything else", () => {
    const s = newState(
      {
        held: [
          [5, { startedAt: START, args: "a", bg: true }],
          [6, { startedAt: START, args: "b", stopped: true, bg: true }],
        ],
      },
      0,
    );
    const procs = [5, 6].map((pid) => ({
      pid,
      ppid: 1,
      nice: 10,
      stat: "S",
      cpu: 0,
      startedAt: START,
      tty: "??",
      args: pid === 5 ? "a" : "b",
    }));
    const types = (acts: Action[]) => acts.map((a) => `${a.type} ${a.pid}`);
    s.held.set(7, { startedAt: START, args: "gone", stopped: true, bg: true });
    expect(types(release(s, procs))).toEqual(["cont 6", "unbg 5", "unbg 6"]);
    expect(types(release(s, null))).toEqual(["cont 6", "cont 7"]); // No ps: SIGCONT only.
    expect(
      types(
        decide(
          procs,
          s,
          { app: APP, self: SELF, pauseAll: false, busy: 0 },
          START,
        ),
      ),
    ).toEqual(["cont 6", "unbg 5", "unbg 6"]);
  });

  it("forgets a hold it failed to take, reports EPERM once, and never retries", () => {
    const mac = new Mac();
    const claude = mac.agent();
    mac.tick(2).pauseAll = true;
    const stop = { type: "stop", pid: claude, name: "claude" } as const;
    mac.s.held.set(claude, {
      startedAt: START,
      args: "claude --verbose",
      stopped: true,
    });
    settle(mac.s, stop, "EPERM", START);
    settle(mac.s, stop, "EPERM", START);
    expect([
      mac.s.held.has(claude),
      mac.s.events.filter((e) => e.error).length,
    ]).toEqual([false, 1]);
    expect(mac.tick(3).of("stop")).toEqual([]);
  });

  it("lets go after a restart of what is still the same process, unless Pause all is still on", () => {
    const mac = new Mac();
    const [a, b, c] = [mac.agent(), mac.agent(), mac.agent()];
    mac.tick(2).pauseAll = true;
    mac.tick();
    const saved = JSON.parse(JSON.stringify(toSaved(mac.s)));
    mac.remove(b);
    mac.add({ pid: b, ppid: 1, args: "/usr/bin/ssh" });
    saved.held.push([
      c + 100,
      { startedAt: START - 3600e3, args: "old", stopped: true },
    ]);
    expect(
      newState({ held: [null, 5, [1]], events: [null, 3] }, 0),
    ).toMatchObject({ held: new Map(), events: [] });
    const restarted = newState(saved, START - 60e3);
    expect([...restarted.held.keys()]).toEqual([a, b, c]);
    const procs = [...mac.procs.values()];
    const still = decide(
      procs,
      restarted,
      { app: APP, self: SELF, pauseAll: true, busy: 0 },
      mac.now,
    );
    expect([still, [...restarted.held.keys()]]).toEqual([[], [a, c]]);
    const off = decide(
      procs,
      restarted,
      { app: APP, self: SELF, pauseAll: false, busy: 0 },
      mac.now,
    );
    expect(off.map((x) => `${x.type} ${x.pid}`)).toEqual([
      `cont ${a}`,
      `cont ${c}`,
    ]);
  });
});
