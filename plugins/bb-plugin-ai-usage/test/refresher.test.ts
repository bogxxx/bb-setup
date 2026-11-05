// Scheduled refreshes: one timer per machine however often it is asked, nothing
// scheduled or started after dispose, and dispose cancels what is waiting.
import { describe, expect, test } from "bun:test";
import { Refresher } from "../src/schedule";

/** Timers that the test fires by hand. */
function fakeClock() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    later: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => {
      (timer as { cancelled: boolean }).cancelled = true;
    },
    fireAll() {
      for (const timer of timers) if (!timer.cancelled) timer.fn();
    },
  };
}

describe("one refresh per machine", () => {
  test("repeated triggers for a machine with a timer pending add nothing", () => {
    const clock = fakeClock();
    const started: string[] = [];
    const refresher = new Refresher((id) => started.push(id), clock.later, clock.cancel);
    refresher.schedule(["predator", "oracle"]);
    refresher.schedule(["predator", "oracle"]);
    refresher.schedule(["predator"]);
    expect(clock.timers.length).toBe(2);
    expect(refresher.pending).toBe(2);
    clock.fireAll();
    expect(started).toEqual(["predator", "oracle"]);
    expect(refresher.pending).toBe(0);
  });

  test("a machine can be scheduled again once its timer has fired", () => {
    const clock = fakeClock();
    const started: string[] = [];
    const refresher = new Refresher((id) => started.push(id), clock.later, clock.cancel);
    refresher.schedule(["predator"]);
    clock.fireAll();
    refresher.schedule(["predator"]);
    expect(clock.timers.length).toBe(2);
    clock.timers[1]!.fn();
    expect(started).toEqual(["predator", "predator"]);
  });

  test("each machine starts a step after the one before it", () => {
    const clock = fakeClock();
    const refresher = new Refresher(() => {}, clock.later, clock.cancel);
    refresher.schedule(["a", "b", "c"]);
    expect(clock.timers.map((t) => t.ms)).toEqual([0, 2_000, 4_000]);
  });
});

describe("dispose", () => {
  test("a schedule that races dispose starts nothing and leaves no timer", () => {
    // refreshConnected awaits the host list; dispose can land during that wait. The schedule
    // that follows must do nothing.
    const clock = fakeClock();
    const started: string[] = [];
    const refresher = new Refresher((id) => started.push(id), clock.later, clock.cancel);
    refresher.dispose();
    refresher.schedule(["predator", "oracle"]);
    expect(clock.timers.length).toBe(0);
    expect(refresher.pending).toBe(0);
    clock.fireAll();
    expect(started).toEqual([]);
  });

  test("dispose cancels the timers waiting to start", () => {
    const clock = fakeClock();
    const started: string[] = [];
    const refresher = new Refresher((id) => started.push(id), clock.later, clock.cancel);
    refresher.schedule(["predator", "oracle", "CPC"]);
    refresher.dispose();
    expect(clock.timers.every((t) => t.cancelled)).toBe(true);
    clock.fireAll();
    expect(started).toEqual([]);
    expect(refresher.pending).toBe(0);
  });

  test("a timer that fires after dispose does not start its refresh", () => {
    const clock = fakeClock();
    const started: string[] = [];
    const refresher = new Refresher((id) => started.push(id), clock.later, clock.cancel);
    refresher.schedule(["predator"]);
    // Dispose without cancellation (a timer already due); the guard must still stop the start.
    const fire = clock.timers[0]!.fn;
    refresher.dispose();
    fire();
    expect(started).toEqual([]);
  });
});
