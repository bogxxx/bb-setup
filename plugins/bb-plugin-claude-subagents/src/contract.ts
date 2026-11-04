import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const displayStatusSchema = z.enum(["in_progress", "finished", "failed", "interrupted"]);
export type DisplayStatus = z.infer<typeof displayStatusSchema>;

export const bbStatusSchema = z.enum(["pending", "completed", "failed", "interrupted"]);
export const taskStatusSchema = z.enum([
  "completed",
  "failed",
  "killed",
  "paused",
  "pending",
  "running",
  "stopped",
]);
export const taskTypeSchema = z.enum(["local_agent", "local_subagent"]);

const usageSchema = z
  .object({
    totalTokens: z.number(),
    toolUses: z.number(),
    durationMs: z.number(),
  })
  .strict();

const agentRowSchema = z
  .object({
    familyId: z.string(),
    sessionId: z.string(),
    description: z.string(),
    taskType: taskTypeSchema,
    status: displayStatusSchema,
    bbStatus: bbStatusSchema,
    taskStatus: taskStatusSchema,
    agentType: z.string().nullable(),
    model: z
      .object({
        requested: z.string().nullable(),
        resolved: z.string().nullable(),
      })
      .strict(),
    usage: usageSchema.nullable(),
    runCount: z.number().int(),
    startedAt: z.number(),
    updatedAt: z.number(),
    error: z.string().nullable(),
    stale: z.boolean(),
  })
  .strict();

export type AgentRow = z.infer<typeof agentRowSchema>;

const countsSchema = z
  .object({
    in_progress: z.number().int(),
    finished: z.number().int(),
    failed: z.number().int(),
    interrupted: z.number().int(),
  })
  .strict();

const listOutputSchema = z
  .object({
    state: z.enum(["ok", "not_claude", "no_environment", "unsupported_host"]),
    notice: z.string().nullable(),
    agents: z.array(agentRowSchema),
    truncated: z.boolean(),
    counts: countsSchema,
    lastSeq: z.number(),
  })
  .strict();

export type ListSubagentsResult = z.infer<typeof listOutputSchema>;

const userItemSchema = z
  .object({
    kind: z.literal("user"),
    index: z.number().int(),
    ts: z.number(),
    text: z.string(),
    truncated: z.boolean(),
    origin: z.enum(["prompt", "message", "notification"]),
  })
  .strict();

const assistantItemSchema = z
  .object({
    kind: z.literal("assistant"),
    index: z.number().int(),
    ts: z.number(),
    text: z.string(),
    truncated: z.boolean(),
    model: z.string().nullable(),
  })
  .strict();

const thinkingItemSchema = z
  .object({
    kind: z.literal("thinking"),
    index: z.number().int(),
    ts: z.number(),
    text: z.string(),
    truncated: z.boolean(),
    redacted: z.boolean(),
  })
  .strict();

const toolItemSchema = z
  .object({
    kind: z.literal("tool"),
    index: z.number().int(),
    ts: z.number(),
    name: z.string(),
    toolUseId: z.string(),
    input: z.string(),
    result: z
      .object({
        text: z.string(),
        isError: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const chatItemSchema = z.discriminatedUnion("kind", [
  userItemSchema,
  assistantItemSchema,
  thinkingItemSchema,
  toolItemSchema,
]);

export type ChatItem = z.infer<typeof chatItemSchema>;

const detailOutputSchema = z
  .object({
    agent: agentRowSchema,
    models: z
      .object({
        requestedAlias: z.string().nullable(),
        requested: z.array(z.string()),
        resolved: z.array(
          z
            .object({
              model: z.string(),
              calls: z.number().int(),
            })
            .strict(),
        ),
        effort: z.string().nullable(),
        advisor: z.string().nullable(),
      })
      .strict(),
    usage: z
      .object({
        apiCalls: z.number().int(),
        input: z.number(),
        output: z.number(),
        cacheCreate: z.number(),
        cacheRead: z.number(),
        thinking: z.number(),
      })
      .strict(),
    thinking: z
      .object({
        state: z.enum(["present", "summarized", "redacted", "missing", "none"]),
        blocks: z.number().int(),
        redactedBlocks: z.number().int(),
        emptyBlocks: z.number().int(),
        note: z.string(),
      })
      .strict(),
    transcript: z
      .object({
        source: z.enum(["jsonl", "output_file", "summary_only"]),
        path: z.string().nullable(),
        sizeBytes: z.number().nullable(),
        modifiedAtMs: z.number().nullable(),
        lagging: z.boolean(),
        malformedLines: z.number().int(),
        notice: z.string().nullable(),
      })
      .strict(),
    items: z.array(chatItemSchema),
    page: z
      .object({
        total: z.number().int(),
        start: z.number().int(),
        hasEarlier: z.boolean(),
        before: z.number().int().nullable(),
      })
      .strict(),
    finalSummary: z.string().nullable(),
  })
  .strict();

export type SubagentDetailResult = z.infer<typeof detailOutputSchema>;

export const rpcContract = defineRpcContract({
  listSubagents: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: listOutputSchema,
  },
  subagentDetail: {
    input: z
      .object({
        threadId: z.string().min(1),
        familyId: z.string(),
        before: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        filter: z.enum(["all", "chat", "thinking"]).optional(),
      })
      .strict(),
    output: detailOutputSchema,
  },
});

export type DetailFilter = "all" | "chat" | "thinking";
