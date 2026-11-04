// A run that times out leaves nothing behind: the child and what it started are
// stopped, so a grandchild that inherited the output pipes cannot keep working.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/spawn";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("a timed-out run stops its grandchildren", () => {
  test("a grandchild that inherited the pipes cannot write after the timeout", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-usage-kill-"));
    const marker = path.join(dir, "grandchild-wrote");
    try {
      // The child starts a grandchild that inherits its pipes, waits 1.5 s, then writes a marker file.
      // The child itself waits forever, so only the timeout ends it.
      const grandchild = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 1500);`;
      const child = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`;
      const out = await run(process.execPath, ["-e", child], { env: process.env as Record<string, string>, timeoutMs: 400 });
      expect(out.timedOut).toBe(true);
      await sleep(2500);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
