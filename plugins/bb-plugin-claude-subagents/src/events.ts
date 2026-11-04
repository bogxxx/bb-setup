import { isFamilyId, isSessionId } from "./paths";
import { asBbStatus, asTaskStatus, displayStatus, type BbStatus, type DisplayStatus, type TaskStatus } from "./status";

const STALE_MS = 10 * 60 * 1000;
const DESCRIPTION_LIMIT = 500;
const ERROR_LIMIT = 500;
const AGENT_LIMIT = 200;

export type BackgroundUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

export type BackgroundItem = {
  type: string;
  id: string;
  familyId?: string;
  description?: string;
  taskType?: string;
  status?: string;
  taskStatus?: string;
  summary?: string | null;
  error?: string | null;
  outputFile?: string | null;
  skipTranscript?: boolean;
  usage?: BackgroundUsage | null;
};

export type BackgroundEvent = {
  seq: number;
  createdAt: number;
  type: string;
  providerThreadId: string;
  item: BackgroundItem;
};

export type RunRecord = {
  itemId: string;
  maxSeq: number;
  status: BbStatus;
  taskStatus: TaskStatus;
  usage: BackgroundUsage | null;
  summary: string | null;
  outputFile: string | null;
  error: string | null;
  skipTranscript: boolean;
};

export type CompletedRecord = {
  seq: number;
  summary: string | null;
  outputFile: string | null;
  error: string | null;
};

export type AgentRecord = {
  familyId: string;
  sessionId: string;
  description: string;
  taskType: "local_agent" | "local_subagent";
  runs: RunRecord[];
  startedAt: number;
  updatedAt: number;
  firstSeq: number;
  maxSeq: number;
  descriptionSeq: number;
  completed: CompletedRecord | null;
  skipTranscript: boolean;
  agentType: string | null;
  requestedAlias: string | null;
  metaCached: boolean;
  resolvedModel: string | null;
};

export type Roster = {
  lastSeq: number;
  agents: Map<string, AgentRecord>;
};

export type AgentDraft = {
  familyId: string;
  sessionId: string;
  description: string;
  taskType: "local_agent" | "local_subagent";
  status: DisplayStatus;
  bbStatus: BbStatus;
  taskStatus: TaskStatus;
  agentType: string | null;
  model: { requested: string | null; resolved: string | null };
  usage: BackgroundUsage | null;
  runCount: number;
  startedAt: number;
  updatedAt: number;
  error: string | null;
  stale: boolean;
};

export function createRoster(): Roster {
  return { lastSeq: 0, agents: new Map() };
}

export function backgroundEventFromRow(row: {
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
}): BackgroundEvent | null {
  if (!row || typeof row.data !== "object" || row.data === null) return null;
  const data = row.data as { providerThreadId?: unknown; item?: unknown };
  if (typeof data.providerThreadId !== "string" || !data.item || typeof data.item !== "object") return null;
  const item = data.item as BackgroundItem;
  if (item.type !== "backgroundTask" || typeof item.id !== "string") return null;
  return {
    seq: row.seq,
    createdAt: row.createdAt,
    type: row.type,
    providerThreadId: data.providerThreadId,
    item,
  };
}

export function applyEvents(roster: Roster, events: readonly BackgroundEvent[]): void {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    if (event.seq > roster.lastSeq) roster.lastSeq = event.seq;
    const taskType = event.item.taskType;
    if (taskType !== "local_agent" && taskType !== "local_subagent") continue;
    const familyId = event.item.familyId;
    if (!familyId || !isFamilyId(familyId)) continue;
    const status = asBbStatus(event.item.status);
    if (!status) continue;

    let agent = roster.agents.get(familyId);
    if (!agent) {
      agent = {
        familyId,
        sessionId: "",
        description: "",
        taskType,
        runs: [],
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        firstSeq: event.seq,
        maxSeq: event.seq,
        descriptionSeq: -1,
        completed: null,
        skipTranscript: false,
        agentType: null,
        requestedAlias: null,
        metaCached: false,
        resolvedModel: null,
      };
      roster.agents.set(familyId, agent);
    }

    if (event.seq <= agent.firstSeq) {
      agent.firstSeq = event.seq;
      agent.startedAt = event.createdAt;
    }
    if (event.seq >= agent.maxSeq) {
      agent.maxSeq = event.seq;
      agent.updatedAt = event.createdAt;
      agent.taskType = taskType;
      agent.skipTranscript = event.item.skipTranscript === true;
    }
    if (isSessionId(event.providerThreadId)) agent.sessionId = event.providerThreadId;
    const description = event.item.description?.trim();
    if (description && event.seq >= agent.descriptionSeq) {
      agent.description = clip(description, DESCRIPTION_LIMIT);
      agent.descriptionSeq = event.seq;
    }

    let run = agent.runs.find((entry) => entry.itemId === event.item.id);
    if (!run) {
      run = {
        itemId: event.item.id,
        maxSeq: -1,
        status,
        taskStatus: "pending",
        usage: null,
        summary: null,
        outputFile: null,
        error: null,
        skipTranscript: false,
      };
      agent.runs.push(run);
    }
    if (event.seq >= run.maxSeq) {
      run.maxSeq = event.seq;
      run.status = status;
      run.taskStatus = asTaskStatus(event.item.taskStatus);
      run.skipTranscript = event.item.skipTranscript === true;
      if (event.item.usage) run.usage = event.item.usage;
    }
    if (event.type === "item/backgroundTask/completed" && (!agent.completed || event.seq >= agent.completed.seq)) {
      agent.completed = {
        seq: event.seq,
        summary: typeof event.item.summary === "string" ? event.item.summary : null,
        outputFile: typeof event.item.outputFile === "string" ? event.item.outputFile : null,
        error: typeof event.item.error === "string" ? clip(event.item.error, ERROR_LIMIT) : null,
      };
      if (event.seq >= run.maxSeq) {
        run.summary = agent.completed.summary;
        run.outputFile = agent.completed.outputFile;
        run.error = agent.completed.error;
      }
    }
  }
}

export function projectRoster(roster: Roster, options: { threadStatus: string; now: number }): AgentDraft[] {
  const rows: AgentDraft[] = [];
  for (const agent of roster.agents.values()) {
    const latest = latestRun(agent);
    if (!latest) continue;
    const status = displayStatus(latest.status, latest.taskStatus);
    if (!status) continue;
    const stale =
      status === "in_progress" &&
      options.threadStatus !== "active" &&
      options.now - agent.updatedAt >= STALE_MS;
    rows.push({
      familyId: agent.familyId,
      sessionId: agent.sessionId,
      description: agent.description,
      taskType: agent.taskType,
      status,
      bbStatus: latest.status,
      taskStatus: latest.taskStatus,
      agentType: agent.agentType,
      model: { requested: agent.requestedAlias, resolved: agent.resolvedModel },
      usage: latest.usage,
      runCount: agent.runs.length,
      startedAt: agent.startedAt,
      updatedAt: agent.updatedAt,
      error: latest.error,
      stale,
    });
  }
  rows.sort((a, b) => {
    const rank = (status: DisplayStatus) => (status === "in_progress" ? 0 : 1);
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0;
  });
  return rows;
}

export function latestRun(agent: AgentRecord): RunRecord | null {
  let latest: RunRecord | null = null;
  for (const run of agent.runs) {
    if (!latest || run.maxSeq > latest.maxSeq) latest = run;
  }
  return latest;
}

export function visibleAgents(rows: readonly AgentDraft[]): { agents: AgentDraft[]; truncated: boolean } {
  if (rows.length <= AGENT_LIMIT) return { agents: [...rows], truncated: false };
  return { agents: rows.slice(0, AGENT_LIMIT), truncated: true };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function emptyCounts(): Record<DisplayStatus, number> {
  return { in_progress: 0, finished: 0, failed: 0, interrupted: 0 };
}

export function countStatuses(rows: readonly AgentDraft[]): Record<DisplayStatus, number> {
  const counts = emptyCounts();
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
