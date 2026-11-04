import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentPaths, claudeHome, encodeCwd, isAgentOutputFile, isFamilyId, isSessionId } from "../src/paths";

const SESSION = "28a3d5a9-f914-41db-9dba-52334121d12a";
const FAMILY = "a707af244ea897296";

describe("agent paths", () => {
  it("encodes the monero working directory the way Claude does", () => {
    expect(encodeCwd("C:\\Users\\krech\\projects\\monero-money-managment")).toBe(
      "C--Users-krech-projects-monero-money-managment",
    );
  });

  it("rejects invalid ids", () => {
    expect(isFamilyId("../etc")).toBe(false);
    expect(isFamilyId("")).toBe(false);
    expect(isFamilyId("a".repeat(65))).toBe(false);
    expect(isSessionId("not-a-uuid")).toBe(false);
    expect(agentPaths("C:\\Users\\krech\\.claude", "C:\\work\\repo", "not-a-uuid", FAMILY)).toBeNull();
    expect(agentPaths("C:\\Users\\krech\\.claude", "C:\\work\\repo", SESSION, "../etc")).toBeNull();
  });

  it("joins with the platform of the working directory", () => {
    const windows = agentPaths(
      "C:\\Users\\krech\\.claude",
      "C:\\Users\\krech\\projects\\monero-money-managment",
      SESSION,
      FAMILY,
    );
    expect(windows?.jsonl).toBe(
      "C:\\Users\\krech\\.claude\\projects\\C--Users-krech-projects-monero-money-managment\\28a3d5a9-f914-41db-9dba-52334121d12a\\subagents\\agent-a707af244ea897296.jsonl",
    );
    const posix = agentPaths("/home/me/.claude", "/home/me/repo", SESSION, FAMILY);
    expect(posix?.jsonl).toBe(
      "/home/me/.claude/projects/-home-me-repo/28a3d5a9-f914-41db-9dba-52334121d12a/subagents/agent-a707af244ea897296.jsonl",
    );
    expect(posix?.jsonl.includes("\\")).toBe(false);
  });

  it("accepts only the task output path as a transcript fallback", () => {
    const output = `C:\\Users\\krech\\AppData\\Local\\Temp\\claude\\abc\\${SESSION}\\tasks\\${FAMILY}.output`;
    expect(isAgentOutputFile(output, SESSION, FAMILY)).toBe(true);
    expect(isAgentOutputFile(`C:\\temp\\${FAMILY}.output`, SESSION, FAMILY)).toBe(false);
    expect(isAgentOutputFile(`/tmp/claude/foo..bar/${SESSION}/tasks/${FAMILY}.output`, SESSION, FAMILY)).toBe(true);
  });

  it("rejects . and .. segments, including a .. hash", () => {
    expect(isAgentOutputFile(`/tmp/claude/../${SESSION}/tasks/${FAMILY}.output`, SESSION, FAMILY)).toBe(false);
    expect(isAgentOutputFile(`/tmp/claude/./${SESSION}/tasks/${FAMILY}.output`, SESSION, FAMILY)).toBe(false);
    expect(isAgentOutputFile(`C:\\temp\\claude\\..\\${SESSION}\\tasks\\${FAMILY}.output`, SESSION, FAMILY)).toBe(false);
  });

  it("builds a POSIX home without a backslash directory segment", () => {
    withConfigDir(undefined, () => {
      const cwd = "/home/me/repo";
      const home = claudeHome(cwd);
      const paths = agentPaths(home, cwd, SESSION, FAMILY);
      expect(paths).not.toBeNull();
      for (const filePath of [home, paths!.directory, paths!.meta, paths!.jsonl]) {
        for (const segment of filePath.split("/")) {
          expect(segment.includes("\\")).toBe(false);
        }
      }
    });
  });

  it("uses path.win32 for a Windows home and honors CLAUDE_CONFIG_DIR", () => {
    withConfigDir(undefined, () => {
      expect(claudeHome("C:\\work\\repo")).toBe(path.win32.join(os.homedir(), ".claude"));
    });
    withConfigDir("/opt/claude", () => {
      expect(claudeHome("/home/me/repo")).toBe("/opt/claude");
      expect(claudeHome("C:\\work\\repo")).toBe("/opt/claude");
    });
  });
});

function withConfigDir(value: string | undefined, run: () => void): void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}
