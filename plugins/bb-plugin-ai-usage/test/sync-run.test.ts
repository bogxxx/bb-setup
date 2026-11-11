// A child that ignores SIGTERM, as agy does, must not hold a synchronous call past its timeout.
import { describe, expect, test } from "bun:test";
import { runSync } from "../src/sync-run";

describe("runSync", () => {
  test("a child that ignores SIGTERM is killed at the timeout, so the call returns", () => {
    const script = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const started = Date.now();
    const run = runSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 500 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.signal).toBe("SIGKILL");
  }, 20_000);
});
