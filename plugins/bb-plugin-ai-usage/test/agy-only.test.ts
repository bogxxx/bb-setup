// Gravity with only the agy CLI signed in: no token, no state file. The card comes from
// `agy -p "/quota"` alone. A fake agy in a temporary home prints the rows, and no network call is made.
// The reader runs in a child process, because the home directory is read once per process.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

test("agy signed in with no token and no state file: the Gravity card shows agy's windows, not the signed-out card", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agy-only-"));
  try {
    const fixture = path.join(home, "quota.txt");
    writeFileSync(
      fixture,
      [
        "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-14T21:50:50Z",
        "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-08T02:50:50Z",
        "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-14T21:50:50Z",
        "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-08T02:50:50Z",
        "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t49%\t2026-11-14T18:36:11Z",
        "",
      ].join("\n"),
    );
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const agy = path.join(home, ".local", "bin", "agy");
    writeFileSync(agy, `#!/bin/sh\ncat '${fixture}'\n`);
    chmodSync(agy, 0o755);

    const module = path.join(import.meta.dir, "../src/local-providers.ts");
    const script = `import { quotaLogins } from ${JSON.stringify(module)};
console.log(JSON.stringify(quotaLogins().filter((login) => login.provider === "antigravity")));`;
    const run = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(0);
    const gravity = JSON.parse(String(run.stdout).trim().split("\n").pop()!) as { name: string; windows: { name: string; percentUsed: number; resetsAt: string | null }[] }[];
    expect(gravity).toHaveLength(1);
    expect(gravity[0]!.name).toBe("Gravity");
    expect(gravity[0]!.windows.map((w) => [w.name, w.percentUsed, w.resetsAt])).toEqual([
      ["Gemini 4 Argon · weekly", 51, "2026-11-14T18:36:11Z"],
      ["Gemini · 5-hour", 0, "2026-11-08T02:50:50Z"],
      ["Gemini · weekly", 0, "2026-11-14T21:50:50Z"],
      ["Claude & GPT · 5-hour", 0, "2026-11-08T02:50:50Z"],
      ["Claude & GPT · weekly", 0, "2026-11-14T21:50:50Z"],
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
