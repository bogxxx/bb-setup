export function assistantLine(options: {
  id?: string;
  model?: string;
  requestedModel?: string;
  effort?: string;
  advisor?: string;
  stop?: string;
  thinkingDisplay?: string;
  outputTokens?: number;
  inputTokens?: number;
  cacheCreate?: number;
  cacheRead?: number;
  thinkingTokens?: number;
  content: unknown;
  uuid?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: options.uuid ?? "u1",
    requestId: "req-1",
    requestedModel: options.requestedModel,
    effort: options.effort,
    advisorModel: options.advisor,
    thinkingDisplay: options.thinkingDisplay,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      id: options.id ?? "m1",
      model: options.model ?? "claude-haiku-5-5",
      stop_reason: options.stop ?? "end_turn",
      usage: {
        input_tokens: options.inputTokens ?? 1,
        output_tokens: options.outputTokens ?? 2,
        cache_creation_input_tokens: options.cacheCreate ?? 3,
        cache_read_input_tokens: options.cacheRead ?? 4,
        output_tokens_details: { thinking_tokens: options.thinkingTokens ?? 0 },
      },
      content: options.content,
    },
  });
}

export function userLine(content: unknown, timestamp = "2026-01-01T00:00:00.000Z"): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    uuid: "user-1",
    message: { role: "user", content },
  });
}
