import os from "node:os";
import path from "node:path";

const FAMILY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const WINDOWS_CWD = /^[A-Za-z]:[\\/]/;

export function isFamilyId(value: string): boolean {
  return FAMILY_ID.test(value);
}

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function claudeHome(cwd: string, local: boolean): string | null {
  if (!local) {
    const home = remoteHome(cwd);
    return home === null ? null : pathApiForCwd(cwd).join(home, ".claude");
  }
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined) return configured;
  const api = pathApiForCwd(cwd);
  const home = api === path.win32 ? os.homedir() : os.homedir().replace(/\\/g, "/");
  return api.join(home, ".claude");
}

function remoteHome(cwd: string): string | null {
  const windows = /^([A-Za-z]:)[\\/]Users[\\/]([^\\/]+)(?:[\\/]|$)/i.exec(cwd);
  if (windows) return `${windows[1]}\\Users\\${windows[2]}`;
  const posix = /^\/(Users|home)\/([^/]+)(?:\/|$)/.exec(cwd);
  if (posix) return `/${posix[1]}/${posix[2]}`;
  if (/^\/root(?:\/|$)/.test(cwd)) return "/root";
  return null;
}

export function pathApiForCwd(cwd: string): path.PlatformPath {
  return WINDOWS_CWD.test(cwd) ? path.win32 : path.posix;
}

export type AgentPaths = {
  directory: string;
  meta: string;
  jsonl: string;
};

export function agentPaths(home: string, cwd: string, sessionId: string, familyId: string): AgentPaths | null {
  if (!isFamilyId(familyId) || !isSessionId(sessionId)) return null;
  const api = pathApiForCwd(cwd);
  const directory = api.join(home, "projects", encodeCwd(cwd), sessionId);
  return filesInDirectory(directory, cwd, familyId);
}

export function filesInDirectory(directory: string, cwd: string, familyId: string): AgentPaths {
  const api = pathApiForCwd(cwd);
  const base = api.join(directory, "subagents", `agent-${familyId}`);
  return {
    directory,
    meta: `${base}.meta.json`,
    jsonl: `${base}.jsonl`,
  };
}

export function projectsDirectory(home: string, cwd: string): string {
  return pathApiForCwd(cwd).join(home, "projects");
}

export function isAgentOutputFile(filePath: string, sessionId: string, familyId: string): boolean {
  if (!isSessionId(sessionId) || !isFamilyId(familyId)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return false;
  const pattern = new RegExp(
    `/claude(?:-[^/]+)?/[^/]+/${escapeRegExp(sessionId)}/tasks/${escapeRegExp(familyId)}\\.output$`,
  );
  return pattern.test(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
