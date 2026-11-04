import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { DetailFilter, SubagentDetailResult } from "./contract";
import { latestRun, type AgentRecord } from "./events";
import { discoverSessionDirectory, readHostText, rememberSessionDirectory, type ReadResult } from "./host-files";
import { agentRow, NOTICES, openAgent } from "./roster";
import {
  agentPaths,
  claudeHome,
  filesInDirectory,
  isAgentOutputFile,
  isFamilyId,
  isSessionId,
  projectsDirectory,
} from "./paths";
import { clipSummary, pageItems, parseTranscript, type ParsedTranscript } from "./transcript";

type Sdk = BbPluginApi["sdk"];

type CacheEntry = {
  sha256: string;
  parsed: ParsedTranscript;
};

const parsedFiles = new Map<string, CacheEntry>();

export async function loadSubagentDetail(
  sdk: Sdk,
  input: { threadId: string; familyId: string; before?: number; limit?: number; filter?: DetailFilter },
): Promise<SubagentDetailResult> {
  if (!isFamilyId(input.familyId)) {
    throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Invalid familyId" });
  }
  const opened = await openAgent(sdk, input.threadId, input.familyId);
  const latest = latestRun(opened.agent);
  const finished = latest?.status !== "pending";
  const loaded = await loadTranscript(sdk, opened.hostId, opened.cwd, opened.agent, finished);
  if (loaded.parsed) {
    const top = loaded.parsed.models.resolved[0]?.model;
    if (top) opened.agent.resolvedModel = top;
  }
  const row = agentRow(opened.agent, opened.threadStatus, Date.now());
  if (!row) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "Agent not found" });
  const parsed = loaded.parsed ?? parseTranscript("");
  const paged = pageItems(parsed.items, {
    before: input.before,
    limit: input.limit ?? 40,
    filter: input.filter ?? "all",
  });
  return {
    agent: row,
    models: {
      requestedAlias: opened.agent.requestedAlias,
      requested: parsed.models.requested,
      resolved: parsed.models.resolved,
      effort: parsed.models.effort,
      advisor: parsed.models.advisor,
    },
    usage: parsed.usage,
    thinking: parsed.thinking,
    transcript: {
      source: loaded.source,
      path: loaded.path,
      sizeBytes: loaded.sizeBytes,
      modifiedAtMs: loaded.modifiedAtMs,
      lagging: loaded.lagging,
      malformedLines: parsed.malformedLines,
      notice: loaded.notice,
    },
    items: paged.items,
    page: paged.page,
    finalSummary: loaded.useSummary ? clipSummary(latest?.summary ?? null) : null,
  };
}

type LoadedTranscript = {
  source: "jsonl" | "output_file" | "summary_only";
  path: string | null;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
  lagging: boolean;
  notice: string | null;
  useSummary: boolean;
  parsed: ParsedTranscript | null;
};

async function loadTranscript(
  sdk: Sdk,
  hostId: string,
  cwd: string,
  agent: AgentRecord,
  finished: boolean,
): Promise<LoadedTranscript> {
  if (agent.skipTranscript) {
    return {
      source: "summary_only",
      path: null,
      sizeBytes: null,
      modifiedAtMs: null,
      lagging: false,
      notice: NOTICES.skipTranscript,
      useSummary: true,
      parsed: null,
    };
  }

  const home = claudeHome(cwd);
  const encoded = isSessionId(agent.sessionId) ? agentPaths(home, cwd, agent.sessionId, agent.familyId) : null;
  let read: ReadResult = { ok: false, missing: true, message: NOTICES.transcriptMissing };
  let jsonlPath = encoded?.jsonl ?? null;
  if (encoded) {
    read = await readHostText(sdk, hostId, encoded.jsonl);
    if (read.ok) {
      rememberSessionDirectory(hostId, agent.sessionId, encoded.directory);
    } else {
      const discovered = await discoverSessionDirectory(sdk, hostId, projectsDirectory(home, cwd), agent.sessionId);
      if (discovered) {
        const alt = filesInDirectory(discovered, cwd, agent.familyId);
        if (alt.jsonl !== encoded.jsonl) {
          const retry = await readHostText(sdk, hostId, alt.jsonl);
          if (retry.ok) {
            read = retry;
            jsonlPath = alt.jsonl;
          }
        }
      }
    }
  }

  if (read.ok) return fromFile("jsonl", read.file, finished);

  const outputFile = latestRun(agent)?.outputFile ?? null;
  if (read.missing && outputFile && isAgentOutputFile(outputFile, agent.sessionId, agent.familyId)) {
    const output = await readHostText(sdk, hostId, outputFile);
    if (output.ok) return fromFile("output_file", output.file, finished);
  }

  return {
    source: "summary_only",
    path: jsonlPath,
    sizeBytes: null,
    modifiedAtMs: null,
    lagging: false,
    notice: read.missing ? NOTICES.transcriptMissing : read.message,
    useSummary: true,
    parsed: null,
  };
}

function fromFile(
  source: "jsonl" | "output_file",
  file: { path: string; sha256: string; text: string; sizeBytes: number; modifiedAtMs: number | null },
  finished: boolean,
): LoadedTranscript {
  const parsed = parseCached(file.path, file.sha256, file.text);
  const lagging = finished && !parsed.endedCleanly;
  return {
    source,
    path: file.path,
    sizeBytes: file.sizeBytes,
    modifiedAtMs: file.modifiedAtMs,
    lagging,
    notice: null,
    useSummary: lagging,
    parsed,
  };
}

function parseCached(filePath: string, sha256: string, text: string): ParsedTranscript {
  const existing = parsedFiles.get(filePath);
  if (existing?.sha256 === sha256) {
    parsedFiles.delete(filePath);
    parsedFiles.set(filePath, existing);
    return existing.parsed;
  }
  const parsed = parseTranscript(text);
  parsedFiles.delete(filePath);
  parsedFiles.set(filePath, { sha256, parsed });
  while (parsedFiles.size > 8) {
    const oldest = parsedFiles.keys().next().value;
    if (oldest === undefined) break;
    parsedFiles.delete(oldest);
  }
  return parsed;
}
