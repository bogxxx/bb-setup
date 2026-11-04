import type { ChatItem } from "./contract";

export const TEXT_LIMIT = 4000;
export const TOOL_INPUT_LIMIT = 300;
export const TOOL_RESULT_LIMIT = 500;
export const SUMMARY_LIMIT = 8000;
export const IDENTITY_LIMIT = 200;
export const MODEL_LIST_LIMIT = 32;

export type ThinkingState = "present" | "summarized" | "redacted" | "missing" | "none";

export type ParsedTranscript = {
  items: ChatItem[];
  usage: {
    apiCalls: number;
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    thinking: number;
  };
  models: {
    requested: string[];
    resolved: { model: string; calls: number }[];
    effort: string | null;
    advisor: string | null;
  };
  thinking: {
    state: ThinkingState;
    blocks: number;
    redactedBlocks: number;
    emptyBlocks: number;
    note: string;
  };
  malformedLines: number;
  endedCleanly: boolean;
};

type UsagePick = {
  index: number;
  output: number;
  input: number;
  cacheCreate: number;
  cacheRead: number;
  thinking: number;
  model: string | null;
  requestedModel: string | null;
  effort: string | null;
  advisor: string | null;
};

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export function parseTranscript(text: string): ParsedTranscript {
  const lines = splitLines(text);
  const items: ChatItem[] = [];
  const tools = new Map<string, ToolItem>();
  const pendingResults = new Map<string, { text: string; isError: boolean }>();
  const groups = new Map<string, UsagePick>();
  let malformedLines = 0;
  let seenPrompt = false;
  let seenUserString = false;
  let lastStop: string | null = null;
  let stopAfterUser: string | null = null;
  let summarized = false;
  let blocks = 0;
  let redactedBlocks = 0;
  let emptyBlocks = 0;
  let nextIndex = 0;

  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (lineIndex !== lines.length - 1) malformedLines += 1;
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;
    const type = stringField(record, "type");
    if (!type || type === "attachment" || type.startsWith("api-request")) return;
    const timestamp = epoch(record.timestamp);

    if (type === "user") {
      const message = asRecord(record.message);
      const content = message?.content;
      if (typeof content === "string") {
        seenUserString = true;
        stopAfterUser = null;
        items.push(userItem(nextIndex, timestamp, content, originFor(content, seenPrompt)));
        if (!content.startsWith("[SYSTEM NOTIFICATION")) seenPrompt = true;
        nextIndex += 1;
        return;
      }
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const entry = asRecord(block);
        if (!entry) continue;
        const blockType = stringField(entry, "type");
        if (blockType === "text" && typeof entry.text === "string") {
          seenUserString = true;
          stopAfterUser = null;
          items.push(userItem(nextIndex, timestamp, entry.text, originFor(entry.text, seenPrompt)));
          if (!entry.text.startsWith("[SYSTEM NOTIFICATION")) seenPrompt = true;
          nextIndex += 1;
        } else if (blockType === "tool_result") {
          const id = stringField(entry, "tool_use_id");
          const result = {
            text: clip(resultText(entry.content), TOOL_RESULT_LIMIT),
            isError: entry.is_error === true,
          };
          if (!id) continue;
          const boundedId = clip(id, IDENTITY_LIMIT);
          const tool = tools.get(boundedId);
          if (tool) tool.result = result;
          else pendingResults.set(boundedId, result);
        }
      }
      return;
    }

    if (type !== "assistant") return;
    const message = asRecord(record.message);
    if (!message) return;
    const rawModel = stringField(message, "model");
    if (rawModel === "<synthetic>") return;
    const model = clipIdentity(rawModel);
    if (record.thinkingDisplay === "summarized") summarized = true;
    const stop = stringField(message, "stop_reason");
    if (stop) {
      lastStop = stop;
      if (seenUserString) stopAfterUser = stop;
    }
    rememberUsage(groups, lineIndex, record, message, model);

    const content = message.content;
    const blocksInMessage = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
    for (const block of blocksInMessage) {
      const entry = asRecord(block);
      if (!entry) continue;
      const blockType = stringField(entry, "type");
      if (blockType === "text" && typeof entry.text === "string") {
        const clipped = clipText(entry.text, TEXT_LIMIT);
        items.push({
          kind: "assistant",
          index: nextIndex,
          ts: timestamp,
          text: clipped.text,
          truncated: clipped.truncated,
          model,
        });
        nextIndex += 1;
      } else if (blockType === "thinking") {
        const thinking = typeof entry.thinking === "string" ? entry.thinking : "";
        if (thinking.trim() === "") {
          emptyBlocks += 1;
          continue;
        }
        blocks += 1;
        const clipped = clipText(thinking, TEXT_LIMIT);
        items.push({
          kind: "thinking",
          index: nextIndex,
          ts: timestamp,
          text: clipped.text,
          truncated: clipped.truncated,
          redacted: false,
        });
        nextIndex += 1;
      } else if (blockType === "redacted_thinking") {
        redactedBlocks += 1;
        items.push({
          kind: "thinking",
          index: nextIndex,
          ts: timestamp,
          text: "",
          truncated: false,
          redacted: true,
        });
        nextIndex += 1;
      } else if (blockType === "tool_use") {
        const toolUseId = clip(stringField(entry, "id") ?? "", IDENTITY_LIMIT);
        const item: ToolItem = {
          kind: "tool",
          index: nextIndex,
          ts: timestamp,
          name: clip(stringField(entry, "name") ?? "", IDENTITY_LIMIT),
          toolUseId,
          input: clip(compactJson(entry.input), TOOL_INPUT_LIMIT),
          result: toolUseId ? pendingResults.get(toolUseId) ?? null : null,
        };
        if (toolUseId) {
          tools.set(toolUseId, item);
          pendingResults.delete(toolUseId);
        }
        items.push(item);
        nextIndex += 1;
      }
    }
  });

  const usage = emptyUsage();
  const requested: string[] = [];
  const requestedSeen = new Set<string>();
  const resolvedCounts = new Map<string, number>();
  const efforts: string[] = [];
  const advisors: string[] = [];
  const effortSeen = new Set<string>();
  const advisorSeen = new Set<string>();
  for (const pick of groups.values()) {
    usage.apiCalls += 1;
    usage.input += pick.input;
    usage.output += pick.output;
    usage.cacheCreate += pick.cacheCreate;
    usage.cacheRead += pick.cacheRead;
    usage.thinking += pick.thinking;
    if (pick.model && (resolvedCounts.has(pick.model) || resolvedCounts.size < MODEL_LIST_LIMIT)) {
      resolvedCounts.set(pick.model, (resolvedCounts.get(pick.model) ?? 0) + 1);
    }
    pushDistinct(requested, requestedSeen, pick.requestedModel);
    pushDistinct(efforts, effortSeen, pick.effort);
    pushDistinct(advisors, advisorSeen, pick.advisor);
  }

  const state: ThinkingState =
    redactedBlocks > 0 ? "redacted" : summarized ? "summarized" : blocks > 0 ? "present" : usage.thinking > 0 ? "missing" : "none";

  return {
    items,
    usage,
    models: {
      requested,
      resolved: [...resolvedCounts.entries()]
        .map(([model, calls]) => ({ model, calls }))
        .sort((a, b) => b.calls - a.calls || (a.model < b.model ? -1 : 1)),
      effort: joinDistinct(efforts),
      advisor: joinDistinct(advisors),
    },
    thinking: {
      state,
      blocks,
      redactedBlocks,
      emptyBlocks,
      note: thinkingNote(state, blocks, usage.thinking),
    },
    malformedLines,
    endedCleanly: (seenUserString ? stopAfterUser : lastStop) === "end_turn",
  };
}

export function pageItems(
  items: readonly ChatItem[],
  options: { before?: number; limit: number; filter: "all" | "chat" | "thinking" },
): { items: ChatItem[]; page: { total: number; start: number; hasEarlier: boolean; before: number | null } } {
  const filtered = items.filter((item) => {
    if (options.filter === "thinking") return item.kind === "thinking";
    if (options.filter === "chat") return item.kind !== "thinking";
    return true;
  });
  const window = options.before === undefined ? filtered : filtered.filter((item) => item.index < options.before!);
  const slice = window.slice(-options.limit);
  const hasEarlier = window.length > slice.length;
  return {
    items: slice,
    page: {
      total: filtered.length,
      start: slice[0]?.index ?? 0,
      hasEarlier,
      before: hasEarlier ? slice[0]!.index : null,
    },
  };
}

export function clipSummary(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= SUMMARY_LIMIT ? value : value.slice(0, SUMMARY_LIMIT);
}

function rememberUsage(
  groups: Map<string, UsagePick>,
  index: number,
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  model: string | null,
): void {
  const messageId = stringField(message, "id") ?? stringField(record, "requestId") ?? stringField(record, "uuid") ?? `line:${index}`;
  const usage = asRecord(message.usage);
  const details = usage ? asRecord(usage.output_tokens_details) : null;
  const pick: UsagePick = {
    index,
    output: numberField(usage?.output_tokens),
    input: numberField(usage?.input_tokens),
    cacheCreate: numberField(usage?.cache_creation_input_tokens),
    cacheRead: numberField(usage?.cache_read_input_tokens),
    thinking: numberField(details?.thinking_tokens),
    model,
    requestedModel: clipIdentity(stringField(record, "requestedModel")),
    effort: clipIdentity(stringField(record, "effort")),
    advisor: clipIdentity(stringField(record, "advisorModel")),
  };
  const current = groups.get(messageId);
  if (!current || pick.output > current.output || (pick.output === current.output && pick.index > current.index)) {
    groups.set(messageId, pick);
  }
}

function userItem(index: number, ts: number, text: string, origin: "prompt" | "message" | "notification"): ChatItem {
  const clipped = clipText(text, TEXT_LIMIT);
  return { kind: "user", index, ts, text: clipped.text, truncated: clipped.truncated, origin };
}

function originFor(text: string, seenPrompt: boolean): "prompt" | "message" | "notification" {
  if (text.startsWith("[SYSTEM NOTIFICATION")) return "notification";
  return seenPrompt ? "message" : "prompt";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const entry = asRecord(block);
    if (!entry) continue;
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
    else if (entry.type === "image" || entry.type === "image_url") parts.push("[image]");
  }
  return parts.join("\n");
}

function thinkingNote(state: ThinkingState, blocks: number, thinkingTokens: number): string {
  if (state === "redacted") return "Thinking was redacted.";
  if (state === "summarized") {
    return blocks === 1 ? "Thinking is summarized (1 block)." : `Thinking is summarized (${blocks} blocks).`;
  }
  if (state === "present") return "Thinking text is present.";
  if (state === "missing") return `${thinkingTokens} thinking tokens used; Claude did not record the text`;
  return "No thinking was recorded.";
}

function joinDistinct(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.join(", ");
}

function emptyUsage(): ParsedTranscript["usage"] {
  return { apiCalls: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, thinking: 0 };
}

function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function epoch(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

function pushDistinct(target: string[], seen: Set<string>, value: string | null): void {
  if (!value || seen.has(value) || target.length >= MODEL_LIST_LIMIT) return;
  seen.add(value);
  target.push(value);
}

export function clipIdentity(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= IDENTITY_LIMIT ? value : value.slice(0, IDENTITY_LIMIT);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function clipText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}
