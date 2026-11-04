// Refreshes start without a poll: connected persistent machines with nothing in
// flight, one step apart; a disconnected or ephemeral machine is left alone.
import { describe, expect, test } from "bun:test";
import { refreshTargets, staggerMs, type MachineState } from "../src/schedule";

const machine = (over: Partial<MachineState>): MachineState => ({ id: "h", connected: true, persistent: true, refreshing: false, ...over });

describe("refresh targets", () => {
  test("every connected persistent machine with nothing in flight, in order", () => {
    const ids = refreshTargets([
      machine({ id: "predator" }),
      machine({ id: "AM", refreshing: true }),
      machine({ id: "oracle" }),
      machine({ id: "offline", connected: false }),
      machine({ id: "ephemeral", persistent: false }),
      machine({ id: "CPC" }),
    ]);
    expect(ids).toEqual(["predator", "oracle", "CPC"]);
  });

  test("nothing connected means nothing to refresh", () => {
    expect(refreshTargets([machine({ connected: false })])).toEqual([]);
    expect(refreshTargets([])).toEqual([]);
  });
});

describe("stagger", () => {
  test("each refresh starts a step after the one before, starting at once", () => {
    expect(staggerMs(0)).toBe(0);
    expect(staggerMs(1)).toBe(2_000);
    expect(staggerMs(3, 500)).toBe(1_500);
    expect(staggerMs(-1)).toBe(0);
  });
});
