// Guard's rules, pure: a `ps` snapshot and the state in, actions out. launchd
// runs this outside the plugin bundle, so Node built-ins only.

const NICE = 10,
  HIGH = 85,
  CALM = 60,
  HIGH_MS = 5e3,
  CALM_MS = 20e3,
  BG_CPU = 10;
const PILE = 3,
  PILE_AGE_MS = 30e3,
  PILE_CPU = 5,
  KILL_MS = 5e3,
  SAME_MS = 30e3,
  EVENTS = 20;
/** The BB server and host daemon (and its workers), not the per-thread agent wrappers. */
const SERVICE = /\/(?:server|host-daemon)\/dist\//u;
const BRIDGE = /\/bb-provider-bridge-worker\.[cm]?js\b/u;

/**
 * @typedef {{ pid: number, ppid: number, nice: number, stat: string, cpu: number,
 *   startedAt: number, tty: string, args: string }} Proc
 * @typedef {{ type: "nice" | "bg" | "unbg" | "stop" | "cont" | "term" | "kill",
 *   pid: number, name: string }} Action
 * @typedef {{ startedAt: number, args: string, bg?: boolean, stopped?: boolean }} Hold
 * @typedef {{ direct: boolean, helper: boolean }} Ours
 * @typedef {{ held: Map<number, Hold>, pauseAll: boolean,
 *   events: { at: number, message: string, error?: boolean }[],
 *   prev: Map<number, Proc & { ours: boolean }>, prevAt: number,
 *   termed: Map<number, Hold & { at: number }>, refused: Set<number>,
 *   overload: boolean, high: number | null, calm: number | null }} State
 */

/** `[[dd-]hh:]mm:ss[.cc]` in seconds. @param {string} text */
const seconds = (text) => {
  const [time, days = "0"] = text.split("-").reverse();
  return (
    Number(days) * 86_400 +
    time.split(":").reduce((sum, part) => sum * 60 + Number(part), 0)
  );
};

/** `ps -axo pid=,ppid=,nice=,stat=,time=,etime=,tty=,args=` read at `now`. @returns {Proc[]} */
export function parsePs(/** @type {string} */ text, /** @type {number} */ now) {
  const rows = text.split("\n").map((line) => line.trim().split(/\s+/u));
  return rows
    .filter((r) => r.length >= 8 && /^\d+$/u.test(r[0]))
    .map((r) => ({
      pid: Number(r[0]),
      ppid: Number(r[1]),
      nice: Number(r[2]),
      stat: r[3],
      cpu: seconds(r[4]),
      startedAt: now - seconds(r[5]) * 1000,
      tty: r[6],
      args: r.slice(7).join(" "),
    }));
}

/** @param {string} args The program's name and its arguments, cut. */
const short = (args) => args.replace(/^\S*\//u, "").slice(0, 60);

/** Pids get reused: the same process has the same start time and command line. */
const same = (/** @type {Hold} */ h, /** @type {Proc | undefined} */ p) =>
  !!p && Math.abs(h.startedAt - p.startedAt) < SAME_MS && h.args === p.args;

/** SIGCONT first: a guard killed midway must not leave stopped what it meant to resume. */
const contFirst = (/** @type {Action[]} */ acts) =>
  acts.sort((a, b) => Number(b.type === "cont") - Number(a.type === "cont"));

/**
 * pid → "core" (BB itself: run from its app bundle), Ours (BB started it), or
 * null (never touched: launchd, the guard and what it runs, a `(name)` that
 * `ps` cannot read yet, everything else). Helpers are what the server and
 * daemon run without a terminal: stopping one hangs BB itself.
 * @param {Proc[]} procs @param {string} app @param {number} self
 */
export function classify(procs, app, self) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kinds = /** @type {Map<number, "core" | Ours | null>} */ (new Map());
  /** @param {Proc} p @returns {"core" | Ours | null} */
  const kindOf = (p) => {
    if (kinds.has(p.pid)) return kinds.get(p.pid) ?? null;
    kinds.set(p.pid, null); // Ends loops in the parents.
    const parent = byPid.get(p.ppid);
    const up =
      parent && p.pid > 1 && p.pid !== self && !p.args.startsWith("(")
        ? kindOf(parent)
        : null;
    const service =
      !!parent && SERVICE.test(parent.args) && !BRIDGE.test(parent.args);
    const kind =
      p.pid === self || p.pid <= 1 || p.args.startsWith("(")
        ? null
        : p.args.startsWith(`${app}/`)
          ? "core"
          : up === "core"
            ? { direct: true, helper: service && p.tty === "??" }
            : up
              ? { direct: false, helper: up.helper }
              : null;
    kinds.set(p.pid, kind);
    return kind;
  };
  procs.forEach(kindOf);
  return kinds;
}

/**
 * From state.json; holds from before `bootAt` are gone with their processes.
 * @param {{ held?: unknown, pauseAll?: unknown, events?: unknown }} saved @param {number} bootAt @returns {State}
 */
export const newState = (saved, bootAt) => ({
  // A damaged file must not crash the guard: launchd would restart it forever.
  held: new Map(
    (Array.isArray(saved.held) ? saved.held : []).filter(
      (e) => Array.isArray(e) && e[1]?.startedAt >= bootAt,
    ),
  ),
  pauseAll: saved.pauseAll === true,
  events: (Array.isArray(saved.events) ? saved.events : []).filter(
    (e) => typeof e?.message === "string",
  ),
  prev: new Map(),
  prevAt: 0,
  termed: new Map(),
  refused: new Set(),
  overload: false,
  high: null,
  calm: null,
});

/** @param {State} s */
export const toSaved = (s) => ({
  held: [...s.held],
  pauseAll: s.pauseAll,
  events: s.events,
});

/** An error repeating the last event is not added again. @param {State} s @param {number} at @param {string} message */
export function note(s, at, message, error = false) {
  if (error && s.events.at(-1)?.message === message) return;
  s.events = [
    ...s.events,
    error ? { at, message, error } : { at, message },
  ].slice(-EVENTS);
}

/** status.json. @param {State} s @param {number} now */
export function statusOf(s, now) {
  const count = (/** @type {"bg" | "stopped"} */ key) =>
    [...s.held.values()].filter((h) => h[key]).length;
  const mode = s.pauseAll ? "paused" : s.overload ? "overload" : "normal";
  return {
    updatedAt: now,
    mode,
    counts: { background: count("bg"), paused: count("stopped") },
    events: s.events,
  };
}

/**
 * One tick; `s` is updated in place. Holds still on the same process carry
 * over, also from a restarted guard's state.json, and are let go unless
 * Pause all or an overload still wants them.
 * @param {Proc[]} procs @param {State} s
 * @param {{ app: string, self: number, pauseAll: boolean, busy: number }} input @param {number} now
 */
export function decide(procs, s, { app, self, pauseAll, busy }, now) {
  const kinds = classify(procs, app, self);
  const live = new Map(procs.map((p) => [p.pid, p]));
  const acts = /** @type {Action[]} */ ([]);
  const act = (
    /** @type {Action["type"]} */ type,
    /** @type {Hold} */ { args },
    /** @type {number} */ pid,
  ) => acts.push({ type, pid, name: short(args) });
  for (const [pid, h] of s.held)
    if (!same(h, live.get(pid))) s.held.delete(pid);
  for (const pid of s.refused) if (!live.has(pid)) s.refused.delete(pid);
  for (const [pid, t] of s.termed) {
    if (!same(t, live.get(pid))) s.termed.delete(pid);
    else if (now - t.at >= KILL_MS) (act("kill", t, pid), (t.at = Infinity)); // Once.
  }
  // BB's now and in the last snapshot: never a process caught mid-fork or exec.
  const ours = /** @type {{ p: Proc, k: Ours, load: number }[]} */ ([]);
  for (const p of procs) {
    const k = kinds.get(p.pid),
      old = s.prev.get(p.pid);
    if (
      !k ||
      k === "core" ||
      !old?.ours ||
      !same(old, p) ||
      s.refused.has(p.pid) ||
      p.stat.includes("Z")
    )
      continue;
    ours.push({
      p,
      k,
      load: (1e5 * (p.cpu - old.cpu)) / Math.max(1, now - s.prevAt),
    }); // % of a core
  }
  s.prev = new Map(
    procs.map((p) => [
      p.pid,
      { ...p, ours: !!kinds.get(p.pid) && kinds.get(p.pid) !== "core" },
    ]),
  );
  s.prevAt = now;
  /** @param {Proc} p @returns {Hold} */
  const hold = (p) =>
    s.held.get(p.pid) ??
    s.held.set(p.pid, { startedAt: p.startedAt, args: p.args }).get(p.pid) ??
    p;
  const stopped = (/** @type {Proc} */ p) => p.stat.includes("T");

  for (const { p } of ours) if (p.nice < NICE) act("nice", p, p.pid);

  s.high = busy >= HIGH ? (s.high ?? now) : null;
  s.calm = busy < CALM ? (s.calm ?? now) : null;
  if (!s.overload && s.high !== null && now - s.high >= HIGH_MS) {
    s.overload = true;
    note(s, now, "Overload: busy processes BB started run on efficiency cores");
  } else if (s.overload && s.calm !== null && now - s.calm >= CALM_MS) {
    s.overload = false;
    note(s, now, "Overload over");
  }
  if (!s.overload) for (const [pid, h] of s.held) if (h.bg) act("unbg", h, pid);
  for (const { p, load } of s.overload ? ours : []) {
    if (load < BG_CPU || stopped(p) || s.held.get(p.pid)?.bg) continue;
    hold(p).bg = true;
    act("bg", p, p.pid);
  }

  // Pile-ups: copies of one command the server or daemon started and never
  // reaped. Agent CLIs run under per-thread wrappers, so they never count.
  const parents = new Set(procs.map((p) => p.ppid));
  const piles = /** @type {Map<string, Proc[]>} */ (new Map());
  for (const { p, k } of ours) {
    if (!k.direct || !k.helper || parents.has(p.pid) || stopped(p)) continue;
    if (1e5 * p.cpu < PILE_CPU * (now - p.startedAt)) continue; // An idle service.
    piles.set(`${p.ppid} ${p.args}`, [
      ...(piles.get(`${p.ppid} ${p.args}`) ?? []),
      p,
    ]);
  }
  for (const pile of piles.values()) {
    pile.sort((a, b) => a.startedAt - b.startedAt);
    if (pile.length < PILE || now - pile[0].startedAt < PILE_AGE_MS) continue;
    const fresh = pile.slice(0, -1).filter((p) => !s.termed.has(p.pid));
    for (const p of fresh) {
      s.termed.set(p.pid, { ...p, at: now });
      act("term", p, p.pid);
    }
    if (fresh.length)
      note(s, now, `Stopped ${fresh.length} copies of ${short(pile[0].args)}`);
  }

  for (const { p, k } of pauseAll ? ours : []) {
    if (k.helper || stopped(p) || s.held.get(p.pid)?.stopped) continue;
    hold(p).stopped = true;
    act("stop", p, p.pid);
  }
  for (const [pid, h] of pauseAll ? [] : s.held)
    if (h.stopped) act("cont", h, pid);
  const n = acts.filter((a) => a.type === (pauseAll ? "stop" : "cont")).length;
  if (pauseAll !== s.pauseAll && n > 0)
    note(s, now, `${pauseAll ? "Paused" : "Resumed"} ${n} processes`);
  s.pauseAll = pauseAll;
  return contFirst(acts);
}

/**
 * After each action, with null or its errno: a hold is forgotten once let go
 * or when taking it failed; EPERM is never retried.
 * @param {State} s @param {Action} a @param {string | null} code @param {number} now
 */
export function settle(s, a, code, now) {
  if (code && code !== "ESRCH") {
    s.refused.add(a.pid);
    note(s, now, `Could not ${a.type} ${a.name} (${a.pid}): ${code}`, true);
  }
  const h = s.held.get(a.pid);
  if (!h) return;
  if (a.type === "cont" || (a.type === "stop" && code)) delete h.stopped;
  if (a.type === "unbg" || (a.type === "bg" && code)) delete h.bg;
  if (!h.stopped && !h.bg) s.held.delete(a.pid);
}

/**
 * Everything held on a process still the same, let go before exit. Without a
 * snapshot only SIGCONT: it does nothing to a process that is not stopped.
 * @param {State} s @param {Proc[] | null} procs
 */
export function release(s, procs) {
  const live = new Map(procs?.map((p) => [p.pid, p]));
  return contFirst(
    [...s.held].flatMap(([pid, h]) =>
      procs && !same(h, live.get(pid))
        ? []
        : [
            ...(h.stopped
              ? [
                  {
                    type: /** @type {const} */ ("cont"),
                    pid,
                    name: short(h.args),
                  },
                ]
              : []),
            ...(h.bg && procs
              ? [
                  {
                    type: /** @type {const} */ ("unbg"),
                    pid,
                    name: short(h.args),
                  },
                ]
              : []),
          ],
    ),
  );
}
