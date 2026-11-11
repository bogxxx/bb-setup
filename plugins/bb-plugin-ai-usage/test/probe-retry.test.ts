// A start refresh whose probe could not run is tried again after short waits, and gives up after the last.
import { describe, expect, test } from "bun:test";
import { retryWithBackoff } from "../src/schedule";

describe("retryWithBackoff", () => {
  test("stops at the first attempt that is done, without waiting again", async () => {
    const waits: number[] = [];
    let calls = 0;
    const done = await retryWithBackoff(
      async () => ++calls === 1,
      [1, 2, 4],
      async (ms) => void waits.push(ms),
    );
    expect(done).toBe(true);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  test("waits the backoff in order until an attempt is done", async () => {
    const waits: number[] = [];
    let calls = 0;
    const done = await retryWithBackoff(
      async () => ++calls === 3,
      [1000, 2000, 4000, 8000],
      async (ms) => void waits.push(ms),
    );
    expect(done).toBe(true);
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  test("gives up after the last wait", async () => {
    const waits: number[] = [];
    let calls = 0;
    const done = await retryWithBackoff(
      async () => (++calls, false),
      [1000, 2000],
      async (ms) => void waits.push(ms),
    );
    expect(done).toBe(false);
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });
});
