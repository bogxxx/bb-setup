import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import type { ListSubagentsResult, SubagentDetailResult } from "../src/contract";
import { IDENTITY_LIMIT } from "../src/transcript";
import { assistantLine, userLine } from "./fixtures/samples";

const META = JSON.stringify({
  agentType: "worker",
  model: "haiku",
  pickedEffortModel: "claude-opus-5-5",
  finished: true,
});

function background(seq: number, item: Record<string, unknown>, sessionId: string) {
  return {
    id: `evt-${seq}`,
    scope: "thread",
    threadId: "thr_unused",
    seq,
    createdAt: 1_700_000_000_000 + seq,
    type: item.status === "pending" ? "item/backgroundTask/progress" : "item/backgroundTask/completed",
    data: {
      providerThreadId: sessionId,
      item: {
        type: "backgroundTask",
        foreground: false,
        skipTranscript: false,
        description: "Agent",
        taskType: "local_agent",
        status: "completed",
        taskStatus: "completed",
        ...item,
      },
    },
  };
}

async function start(options: {
  providerId?: string;
  hostId?: string;
  cwd?: string;
  events?: unknown[];
  files?: Record<string, string>;
  listPaths?: () => Promise<{ paths: { name: string; path: string }[]; truncated: boolean }>;
  read?: (path: string) => string | null;
  eventsList?: (afterSeq: string | undefined) => unknown[];
}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "claude-subagents" });
  harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({
      providerId: options.providerId ?? "claude-code",
      environmentId: "env_1",
      status: "idle",
    }),
  );
  harness.sdk.stub("environments.get", async () => ({
    hostId: options.hostId ?? "host-1",
    path: options.cwd ?? "C:\\work\\repo",
  }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host-1" }));
  harness.sdk.stub("threads.events.list", async (...args: unknown[]) => {
    const input = args[0] as { afterSeq?: string } | undefined;
    if (options.eventsList) return options.eventsList(input?.afterSeq);
    if (input?.afterSeq) return [];
    return options.events ?? [];
  });
  harness.sdk.stub("files.read", async (...args: unknown[]) => {
    const input = args[0] as { path: string };
    const content = options.read
      ? options.read(input.path)
      : (Object.entries(options.files ?? {}).find(([suffix]) => input.path.endsWith(suffix))?.[1] ?? null);
    if (content === null) throw new Error("ENOENT: no such file");
    return {
      content,
      contentEncoding: "utf8",
      sha256: `sha-${input.path}`,
      sizeBytes: content.length,
      path: input.path,
      modifiedAtMs: 10,
    };
  });
  harness.sdk.stub("files.listPaths", async () => {
    if (options.listPaths) return options.listPaths();
    return { paths: [], truncated: false };
  });
  await plugin(bb);
  return harness;
}

describe("claude-subagents server", () => {
  it("lists one row per family and ignores a thread that is not Claude", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const harness = await start({
      events: [
        background(1, { id: "run-1", familyId: "familyone", status: "interrupted", taskStatus: "stopped", description: "Old" }, sessionId),
        background(2, { id: "run-2", familyId: "familyone", status: "completed", description: "New", usage: { totalTokens: 9, toolUses: 2, durationMs: 20 } }, sessionId),
        background(3, { id: "bash-1", familyId: "bashagent", taskType: "local_bash", description: "shell" }, sessionId),
      ],
      files: { "meta.json": META },
    });
    const listed = await harness.behavior.callRpc("listSubagents", { threadId: "thr_list_family" });
    expect(listed).toMatchObject({
      state: "ok",
      agents: [
        {
          familyId: "familyone",
          status: "finished",
          runCount: 2,
          agentType: "worker",
          description: "New",
          model: { requested: "haiku", resolved: null },
          usage: { totalTokens: 9 },
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("claude-opus-5-5");
    expect(JSON.stringify(listed)).not.toContain("bashagent");

    const other = await start({ providerId: "codex" });
    const denied = await other.behavior.callRpc("listSubagents", { threadId: "thr_not_claude" });
    expect(denied).toMatchObject({ state: "not_claude", agents: [], notice: "This thread is not a Claude Code thread." });
  });

  it("falls back to the completed summary when the jsonl is missing", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const harness = await start({
      events: [
        background(
          4,
          { id: "run-1", familyId: "missingone", summary: "All done", outputFile: "C:\\temp\\not-the-task.output" },
          sessionId,
        ),
      ],
    });
    const detail = await harness.behavior.callRpc("subagentDetail", {
      threadId: "thr_missing_jsonl",
      familyId: "missingone",
    });
    expect(detail).toMatchObject({
      transcript: { source: "summary_only", notice: "Transcript file not found", lagging: false },
      finalSummary: "All done",
      items: [],
    });
  });

  it("pages the newest items and refuses an invalid family id", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const jsonl = [0, 1, 2, 3, 4].map((n) => userLine(`message-${n}`, `2026-01-01T00:00:0${n}.000Z`)).join("\n");
    const harness = await start({
      events: [background(1, { id: "run-1", familyId: "pageagent", description: "Paged" }, sessionId)],
      files: { "meta.json": META, ".jsonl": jsonl },
    });
    const first = (await harness.behavior.callRpc("subagentDetail", {
      threadId: "thr_page",
      familyId: "pageagent",
      limit: 2,
    })) as { items: { text: string; index: number }[]; page: { total: number; hasEarlier: boolean; before: number | null } };
    expect(first.page).toMatchObject({ total: 5, hasEarlier: true, before: 3 });
    expect(first.items.map((item) => item.text)).toEqual(["message-3", "message-4"]);

    const earlier = (await harness.behavior.callRpc("subagentDetail", {
      threadId: "thr_page",
      familyId: "pageagent",
      limit: 2,
      before: first.page.before,
    })) as { items: { text: string }[]; page: { hasEarlier: boolean } };
    expect(earlier.items.map((item) => item.text)).toEqual(["message-1", "message-2"]);
    expect(earlier.page.hasEarlier).toBe(true);

    await expect(
      harness.behavior.callRpc("subagentDetail", { threadId: "thr_page", familyId: "../etc" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      harness.behavior.callRpc("subagentDetail", { threadId: "thr_page", familyId: "pageagent", limit: 101 }),
    ).rejects.toThrow();
  });

  it("publishes one realtime signal for a Claude thread event", async () => {
    const harness = await start({});
    await harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_rt", providerId: "claude-code" }),
      sequence: 9,
    });
    await harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_other", providerId: "codex" }),
      sequence: 10,
    });
    expect(harness.realtimeSignals).toEqual([
      { channel: "thread-events", payload: { threadId: "thr_rt", sequence: 9 } },
    ]);
  });

  it("retries an empty or failed session lookup and a failed meta read", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const familyId = "retrymeta";
    const discovered = `D:\\sessions\\${sessionId}`;
    let lookups = 0;
    const harness = await start({
      events: [background(1, { id: "run-1", familyId, status: "completed", description: "Retry" }, sessionId)],
      read: (path) => (path.startsWith(discovered) ? META : null),
      listPaths: async () => {
        lookups += 1;
        if (lookups === 1) return { paths: [], truncated: false };
        if (lookups === 2) throw new Error("transient list failure");
        return { paths: [{ name: sessionId, path: discovered }], truncated: false };
      },
    });
    const threadId = "thr_retry_meta";
    const first = (await harness.behavior.callRpc("listSubagents", { threadId })) as ListSubagentsResult;
    const second = (await harness.behavior.callRpc("listSubagents", { threadId })) as ListSubagentsResult;
    expect(first.agents[0]?.agentType).toBeNull();
    expect(second.agents[0]?.agentType).toBeNull();
    const third = (await harness.behavior.callRpc("listSubagents", { threadId })) as ListSubagentsResult;
    expect(third.agents[0]?.agentType).toBe("worker");
    expect(lookups).toBe(3);
    await harness.behavior.callRpc("listSubagents", { threadId });
    expect(lookups).toBe(3);
  });

  it("does not stick a meta read that failed before the session id existed", async () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const familyId = "latemeta";
    let release = false;
    const harness = await start({
      eventsList: (afterSeq) => {
        if (!afterSeq) {
          return [background(1, { id: "run-1", familyId, status: "completed", description: "Later" }, "session-not-ready")];
        }
        if (!release) return [];
        return [background(2, { id: "run-1", familyId, status: "completed", description: "Later" }, sessionId)];
      },
      files: { [`agent-${familyId}.meta.json`]: META },
    });
    const threadId = "thr_late_meta";
    const first = (await harness.behavior.callRpc("listSubagents", { threadId })) as ListSubagentsResult;
    expect(first.agents[0]?.agentType).toBeNull();
    release = true;
    const second = (await harness.behavior.callRpc("listSubagents", { threadId })) as ListSubagentsResult;
    expect(second.agents[0]?.agentType).toBe("worker");
    expect(second.agents[0]?.model.requested).toBe("haiku");
  });

  it("does not present an older run's summary or output as the latest in-progress run", async () => {
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const familyId = "rerunagent";
    const output = `C:\\Users\\krech\\AppData\\Local\\Temp\\claude\\hash\\${sessionId}\\tasks\\${familyId}.output`;
    const harness = await start({
      events: [
        background(
          1,
          {
            id: "run-1",
            familyId,
            status: "interrupted",
            taskStatus: "stopped",
            error: "old failure",
            summary: "old summary",
            outputFile: output,
          },
          sessionId,
        ),
        background(2, { id: "run-2", familyId, status: "pending", taskStatus: "running", description: "Resumed" }, sessionId),
      ],
      files: { [output]: "stale output from the earlier run" },
    });
    const detail = (await harness.behavior.callRpc("subagentDetail", {
      threadId: "thr_rerun",
      familyId,
    })) as SubagentDetailResult;
    expect(detail.agent).toMatchObject({ status: "in_progress", error: null });
    expect(detail.finalSummary).toBeNull();
    expect(detail.transcript.source).toBe("summary_only");
    const body = JSON.stringify(detail);
    expect(body).not.toContain("old summary");
    expect(body).not.toContain("old failure");
    expect(body).not.toContain("stale output");
  });

  it("bounds an overlong agent type and requested model", async () => {
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const familyId = "longnames";
    const longType = `type-${"t".repeat(10_000)}`;
    const longModel = `model-${"m".repeat(10_000)}`;
    const harness = await start({
      events: [background(1, { id: "run-1", familyId, status: "completed", description: "Long" }, sessionId)],
      files: {
        "meta.json": JSON.stringify({ agentType: longType, model: longModel }),
        ".jsonl": assistantLine({ requestedModel: longModel, content: [{ type: "text", text: "ok" }] }),
      },
    });
    const detail = (await harness.behavior.callRpc("subagentDetail", {
      threadId: "thr_long_names",
      familyId,
    })) as SubagentDetailResult;
    expect(detail.agent.agentType?.startsWith("type-")).toBe(true);
    expect(detail.agent.agentType?.length).toBeLessThanOrEqual(IDENTITY_LIMIT);
    expect(detail.agent.agentType).not.toBe(longType);
    expect(detail.agent.model.requested?.length).toBeLessThanOrEqual(IDENTITY_LIMIT);
    expect(detail.models.requestedAlias?.length).toBeLessThanOrEqual(IDENTITY_LIMIT);
    expect(detail.models.requested[0]?.startsWith("model-")).toBe(true);
    expect(detail.models.requested[0]?.length).toBeLessThanOrEqual(IDENTITY_LIMIT);
    expect(detail.models.requested[0]).not.toBe(longModel);
  });
});

describe("claude-subagents on a non-primary host", () => {
  it("reads the meta and transcript under the remote home and refuses a project outside home", async () => {
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const familyId = "machineagent";
    const cwd = "/Users/bohdan.krechko/Projects/monero";
    const reads: string[] = [];
    const jsonl = userLine("from the mac", "2026-01-01T00:00:00.000Z");
    const harness = await start({
      hostId: "host-mac",
      cwd,
      events: [background(1, { id: "run-1", familyId, status: "completed", description: "Mac" }, sessionId)],
      read: (path) => {
        reads.push(path);
        if (path.endsWith(".meta.json")) return META;
        if (path.endsWith(".jsonl")) return jsonl;
        return null;
      },
    });
    const threadId = "thr_mac";
    const listed = (await harness.behavior.callRpc("listSubagents", { threadId })) as ListSubagentsResult;
    expect(listed).toMatchObject({ state: "ok", agents: [{ familyId, agentType: "worker" }] });
    const detail = (await harness.behavior.callRpc("subagentDetail", { threadId, familyId })) as SubagentDetailResult;
    expect(detail.transcript).toMatchObject({ source: "jsonl" });
    const base = `/Users/bohdan.krechko/.claude/projects/-Users-bohdan-krechko-Projects-monero/${sessionId}/subagents/agent-${familyId}`;
    expect(reads).toContain(`${base}.meta.json`);
    expect(reads).toContain(`${base}.jsonl`);

    const outside = await start({ hostId: "host-mac", cwd: "/opt/monero" });
    const refused = (await outside.behavior.callRpc("listSubagents", { threadId: "thr_outside" })) as ListSubagentsResult;
    expect(refused).toMatchObject({ state: "unsupported_host", agents: [] });
    expect(refused.notice).toContain("home folder");
  });
});
