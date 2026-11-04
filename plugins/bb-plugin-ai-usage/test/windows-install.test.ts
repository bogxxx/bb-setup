// The Windows install: the release's install.ps1 runs from a file, and the team key
// and relay travel in the environment, never on the command line.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { Machine } from "../src/host-impl";
import { windowsBinary, windowsInstallArgs, windowsInstallEnv } from "../src/host-impl";

const KEY = "made-up-team-key-0123456789";
const RELAY = "https://relay.example.invalid";

function windowsMachine(): Machine {
  return {
    env: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", USERPROFILE: "C:\\Users\\test" },
    dirs: [],
    platform: "win32",
    home: "C:\\Users\\test",
    tempDir: "C:\\Users\\test\\AppData\\Local\\Temp\\ai-usage-test",
    fetch: globalThis.fetch,
  } as unknown as Machine;
}

describe("Windows install command", () => {
  test("runs the installer as a file, with no secret in the arguments", () => {
    const args = windowsInstallArgs("C:\\Temp\\install-v0.14.1.ps1");
    expect(args).toContain("-File");
    expect(args).toContain("C:\\Temp\\install-v0.14.1.ps1");
    expect(args.join(" ")).not.toContain(KEY);
    expect(args.join(" ")).not.toContain(RELAY);
  });

  test("the team key and relay are in the environment of the installer", () => {
    const env = windowsInstallEnv(windowsMachine(), { teamKey: KEY, relay: RELAY, onLine: () => {} }, "v0.14.1");
    expect(env.AI_USAGE_TEAM_KEY).toBe(KEY);
    expect(env.AI_USAGE_RELAY).toBe(RELAY);
    expect(env.AI_USAGE_DOWNLOAD_URL).toBe("https://github.com/neoromantic/ai-usage/releases/download/v0.14.1");
    // The same key never appears in the arguments the installer is started with.
    expect(windowsInstallArgs("x.ps1").join(" ")).not.toContain(env.AI_USAGE_TEAM_KEY!);
  });

  test("without a key, the installer gets none; a blank key is not sent", () => {
    const none = windowsInstallEnv(windowsMachine(), { teamKey: null, relay: null, onLine: () => {} }, "v0.14.1");
    expect(none.AI_USAGE_TEAM_KEY).toBeUndefined();
    expect(none.AI_USAGE_RELAY).toBeUndefined();
    const blank = windowsInstallEnv(windowsMachine(), { teamKey: "   ", relay: "", onLine: () => {} }, "v0.14.1");
    expect(blank.AI_USAGE_TEAM_KEY).toBeUndefined();
    expect(blank.AI_USAGE_RELAY).toBeUndefined();
  });

  test("the installed binary is where install.ps1 puts it", () => {
    const env = windowsMachine().env;
    expect(windowsBinary(env)).toBe(path.join("C:\\Users\\test\\AppData\\Local", "Programs", "ai-usage", "ai-usage.exe"));
  });
});
