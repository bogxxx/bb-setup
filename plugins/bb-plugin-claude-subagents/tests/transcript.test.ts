import { describe, expect, it } from "vitest";
import { IDENTITY_LIMIT, MODEL_LIST_LIMIT, parseTranscript } from "../src/transcript";
import { assistantLine, userLine } from "./fixtures/samples";

describe("parseTranscript", () => {
  it("counts three lines with the same message id once, using the largest output", () => {
    const text = [
      assistantLine({ id: "m1", outputTokens: 1, inputTokens: 10, thinkingTokens: 7, content: [{ type: "text", text: "a" }] }),
      assistantLine({ id: "m1", outputTokens: 9, inputTokens: 10, thinkingTokens: 7, content: [{ type: "text", text: "b" }] }),
      assistantLine({ id: "m1", outputTokens: 4, inputTokens: 10, thinkingTokens: 7, content: [{ type: "thinking", thinking: "sum" }], thinkingDisplay: "summarized" }),
    ].join("\n");
    const parsed = parseTranscript(text);
    expect(parsed.usage).toMatchObject({ apiCalls: 1, input: 10, output: 9, thinking: 7 });
    expect(parsed.items.map((item) => item.kind)).toEqual(["assistant", "assistant", "thinking"]);
  });

  it("skips synthetic assistant lines", () => {
    const parsed = parseTranscript(
      [
        assistantLine({ model: "<synthetic>", content: [{ type: "text", text: "hidden" }] }),
        assistantLine({ id: "m2", content: [{ type: "text", text: "shown" }] }),
      ].join("\n"),
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ kind: "assistant", text: "shown" });
    expect(parsed.usage.apiCalls).toBe(1);
  });

  it("links tool results from a string or an array of blocks", () => {
    const text = [
      userLine("do the thing"),
      assistantLine({
        id: "m-tool",
        stop: "tool_use",
        content: [
          { type: "tool_use", id: "tool-1", name: "read", input: { path: "a.txt" } },
          { type: "tool_use", id: "tool-2", name: "see", input: { ok: true } },
        ],
      }),
      userLine([{ type: "tool_result", tool_use_id: "tool-1", is_error: false, content: "file text" }]),
      userLine([
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          is_error: true,
          content: [
            { type: "text", text: "nope" },
            { type: "image", url: "img" },
          ],
        },
      ]),
      userLine("[SYSTEM NOTIFICATION] done"),
      userLine("follow up"),
    ].join("\n");
    const parsed = parseTranscript(text);
    const tools = parsed.items.filter((item) => item.kind === "tool");
    expect(tools[0]).toMatchObject({ name: "read", input: '{"path":"a.txt"}', result: { text: "file text", isError: false } });
    expect(tools[1]).toMatchObject({ result: { text: "nope\n[image]", isError: true } });
    const users = parsed.items.filter((item) => item.kind === "user");
    expect(users.map((item) => item.kind === "user" && item.origin)).toEqual(["prompt", "notification", "message"]);
  });

  it("covers each thinking state", () => {
    const summarized = parseTranscript(assistantLine({ thinkingDisplay: "summarized", content: [{ type: "thinking", thinking: "a summary" }] }));
    expect(summarized.thinking).toMatchObject({ state: "summarized", blocks: 1, note: "Thinking is summarized (1 block)." });

    const redacted = parseTranscript(
      assistantLine({
        thinkingDisplay: "summarized",
        content: [{ type: "redacted_thinking", data: "secret" }],
      }),
    );
    expect(redacted.thinking.state).toBe("redacted");
    expect(redacted.thinking.note).toBe("Thinking was redacted.");
    expect(redacted.items[0]).toMatchObject({ kind: "thinking", redacted: true, text: "" });

    const missing = parseTranscript(
      assistantLine({ thinkingTokens: 12, content: [{ type: "thinking", thinking: "" }, { type: "text", text: "answer" }] }),
    );
    expect(missing.thinking.state).toBe("missing");
    expect(missing.thinking.emptyBlocks).toBe(1);
    expect(missing.thinking.note).toBe("12 thinking tokens used; Claude did not record the text");

    const none = parseTranscript(assistantLine({ content: [{ type: "text", text: "only text" }] }));
    expect(none.thinking).toMatchObject({ state: "none", blocks: 0, note: "No thinking was recorded." });

    const present = parseTranscript(assistantLine({ content: [{ type: "thinking", thinking: "full thought" }] }));
    expect(present.thinking.state).toBe("present");
  });

  it("ignores a partial last line and counts an earlier bad line", () => {
    const good = userLine("hello");
    const partial = parseTranscript(`${good}\n{"type":"user"`);
    expect(partial.malformedLines).toBe(0);
    expect(partial.items).toHaveLength(1);

    const middle = parseTranscript(`${good}\n{not json}\n${userLine("again")}`);
    expect(middle.malformedLines).toBe(1);
    expect(middle.items).toHaveLength(2);
  });

  it("flags truncated text and thinking", () => {
    const text = "a".repeat(4001);
    const parsed = parseTranscript(
      assistantLine({
        content: [
          { type: "text", text },
          { type: "thinking", thinking: text },
        ],
      }),
    );
    expect(parsed.items[0]).toMatchObject({ kind: "assistant", truncated: true, text: "a".repeat(4000) });
    expect(parsed.items[1]).toMatchObject({ kind: "thinking", truncated: true });
  });

  it("bounds requested model names and the distinct list", () => {
    const lines = Array.from({ length: MODEL_LIST_LIMIT + 5 }, (_, index) =>
      assistantLine({
        id: `m-${index}`,
        uuid: `u-${index}`,
        requestedModel: index === 0 ? `model-${"m".repeat(5000)}` : `model-${index}-${"n".repeat(500)}`,
        content: [{ type: "text", text: "x" }],
      }),
    );
    const parsed = parseTranscript(lines.join("\n"));
    expect(parsed.models.requested).toHaveLength(MODEL_LIST_LIMIT);
    expect(parsed.models.requested.every((model) => model.length <= IDENTITY_LIMIT)).toBe(true);
    expect(parsed.models.requested[0]).toBe(`model-${"m".repeat(IDENTITY_LIMIT - "model-".length)}`);
  });
});
