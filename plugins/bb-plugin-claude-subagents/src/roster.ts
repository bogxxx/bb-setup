import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  applyEvents,
  backgroundEventFromRow,
  countStatuses,
  createRoster,
  emptyCounts,
  latestRun,
  projectRoster,
  visibleAgents,
  type AgentRecord,
  type Roster,
} from "./events";
import { discoverSessionDirectory, readHostText, rememberSessionDirectory } from "./host-files";
import { agentPaths, claudeHome, filesInDirectory, isSessionId, projectsDirectory } from "./paths";
import { displayStatus } from "./status";
import { IDENTITY_LIMIT } from "./transcript";
import type { ListSubagentsResult } from "./contract";

type Sdk = BbPluginApi["sdk"];

const EVENT_TYPES = ["item/started", "item/backgroundTask/progress", "item/backgroundTask/completed"] as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 40;
const MAX_THREADS = 20;

export const NOTICES = {
  notClaude: "This thread is not a Claude Code thread.",
  noEnvironment: "This thread has no environment.",
  unsupportedHost: "Claude subagents are available on the primary host only.",
  transcriptMissing: "Transcript file not found",
  skipTranscript: "Claude did not record a transcript",
} as const;

type ThreadCache = {
  roster: Roster;
  hitPageCap: boolean;
};

type OpenThread =
  | { ok: true; threadStatus: string; hostId: string; cwd: string; cache: ThreadCache }
  | { ok: false; result: ListSubagentsResult };

const threads = new Map<string, ThreadCache>();

export async function listSubagents(sdk: Sdk, threadId: string): Promise<ListSubagentsResult> {
  const opened = await openThread(sdk, threadId);
  if (!opened.ok) return opened.result;
  await syncEvents(sdk, threadId, opened.cache);
  const ranked = projectRoster(opened.cache.roster, { threadStatus: opened.threadStatus, now: Date.now() });
  const selected = visibleAgents(ranked).agents;
  await Promise.all(
    selected.map((row) => {
      const agent = opened.cache.roster.agents.get(row.familyId);
      return agent ? ensureMeta(sdk, agent, opened.hostId, opened.cwd) : Promise.resolve();
    }),
  );
  const rows = projectRoster(opened.cache.roster, { threadStatus: opened.threadStatus, now: Date.now() });
  const visible = visibleAgents(rows);
  return {
    state: "ok",
    notice: null,
    agents: visible.agents,
    truncated: opened.cache.hitPageCap || visible.truncated,
    counts: countStatuses(rows),
    lastSeq: opened.cache.roster.lastSeq,
  };
}

export async function openAgent(
  sdk: Sdk,
  threadId: string,
  familyId: string,
): Promise<{ threadStatus: string; hostId: string; cwd: string; agent: AgentRecord }> {
  const opened = await openThread(sdk, threadId);
  if (!opened.ok) {
    throw new experimental_PluginRpcRefusal({ code: "not_found", message: opened.result.notice ?? "Thread not found" });
  }
  await syncEvents(sdk, threadId, opened.cache);
  const agent = opened.cache.roster.agents.get(familyId);
  if (!agent) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "Agent not found" });
  await ensureMeta(sdk, agent, opened.hostId, opened.cwd);
  return { threadStatus: opened.threadStatus, hostId: opened.hostId, cwd: opened.cwd, agent };
}

export function agentRow(agent: AgentRecord, threadStatus: string, now: number) {
  const roster = createRoster();
  roster.agents.set(agent.familyId, agent);
  return projectRoster(roster, { threadStatus, now })[0] ?? null;
}

async function openThread(sdk: Sdk, threadId: string): Promise<OpenThread> {
  let thread: Awaited<ReturnType<Sdk["threads"]["get"]>>;
  try {
    thread = await sdk.threads.get({ threadId });
  } catch (error) {
    throw new experimental_PluginRpcRefusal({
      code: "not_found",
      message: error instanceof Error && error.message ? error.message : "Thread not found",
    });
  }
  if (thread.providerId !== "claude-code") return { ok: false, result: emptyList("not_claude", NOTICES.notClaude) };
  if (!thread.environmentId) return { ok: false, result: emptyList("no_environment", NOTICES.noEnvironment) };
  let environment: Awaited<ReturnType<Sdk["environments"]["get"]>>;
  try {
    environment = await sdk.environments.get({ environmentId: thread.environmentId });
  } catch {
    return { ok: false, result: emptyList("no_environment", NOTICES.noEnvironment) };
  }
  if (!environment.path) return { ok: false, result: emptyList("no_environment", NOTICES.noEnvironment) };
  const config = await sdk.system.config();
  if (!config.primaryHostId || environment.hostId !== config.primaryHostId) {
    return { ok: false, result: emptyList("unsupported_host", NOTICES.unsupportedHost) };
  }
  let cache = threads.get(threadId);
  if (!cache) cache = { roster: createRoster(), hitPageCap: false };
  touch(threadId, cache);
  return { ok: true, threadStatus: thread.status, hostId: environment.hostId, cwd: environment.path, cache };
}

async function syncEvents(sdk: Sdk, threadId: string, cache: ThreadCache): Promise<void> {
  let hitCap = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const previous = cache.roster.lastSeq;
    const rows = await sdk.threads.events.list({
      threadId,
      types: EVENT_TYPES,
      order: "asc",
      limit: String(PAGE_SIZE),
      ...(previous > 0 ? { afterSeq: String(previous) } : {}),
    });
    const events = [];
    for (const row of rows) {
      if (row.seq > cache.roster.lastSeq) cache.roster.lastSeq = row.seq;
      const event = backgroundEventFromRow(row);
      if (event) events.push(event);
    }
    applyEvents(cache.roster, events);
    if (rows.length < PAGE_SIZE || cache.roster.lastSeq === previous) {
      hitCap = false;
      break;
    }
    if (page === MAX_PAGES - 1) hitCap = true;
  }
  cache.hitPageCap = hitCap;
}

async function ensureMeta(sdk: Sdk, agent: AgentRecord, hostId: string, cwd: string): Promise<void> {
  const status = displayStatus(latestRun(agent)?.status ?? "");
  if (agent.metaCached && status !== "in_progress") return;
  if (!isSessionId(agent.sessionId)) return;
  const home = claudeHome(cwd);
  const encoded = agentPaths(home, cwd, agent.sessionId, agent.familyId);
  if (!encoded) return;
  let read = await readHostText(sdk, hostId, encoded.meta);
  let directory = encoded.directory;
  if (!read.ok) {
    const discovered = await discoverSessionDirectory(sdk, hostId, projectsDirectory(home, cwd), agent.sessionId);
    if (discovered && discovered !== encoded.directory) {
      directory = discovered;
      read = await readHostText(sdk, hostId, filesInDirectory(discovered, cwd, agent.familyId).meta);
    }
  }
  if (!read.ok) return;
  const meta = parseMeta(read.file.text);
  agent.agentType = meta.agentType;
  agent.requestedAlias = meta.model;
  agent.metaCached = true;
  rememberSessionDirectory(hostId, agent.sessionId, directory);
}

function parseMeta(text: string): { agentType: string | null; model: string | null } {
  try {
    const parsed = JSON.parse(text) as { agentType?: unknown; model?: unknown };
    return {
      agentType: clipIdentity(parsed.agentType),
      model: clipIdentity(parsed.model),
    };
  } catch {
    return { agentType: null, model: null };
  }
}

function clipIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length <= IDENTITY_LIMIT ? value : value.slice(0, IDENTITY_LIMIT);
}

function touch(threadId: string, cache: ThreadCache): void {
  threads.delete(threadId);
  threads.set(threadId, cache);
  while (threads.size > MAX_THREADS) {
    const oldest = threads.keys().next().value;
    if (oldest === undefined) break;
    threads.delete(oldest);
  }
}

function emptyList(state: ListSubagentsResult["state"], notice: string): ListSubagentsResult {
  return {
    state,
    notice,
    agents: [],
    truncated: false,
    counts: emptyCounts(),
    lastSeq: 0,
  };
}
