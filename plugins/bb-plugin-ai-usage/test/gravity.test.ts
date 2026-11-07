import { describe, expect, test } from "bun:test";
import { limitingWindows } from "../src/format";
import { gravityWindows, probeModels, probeQuota } from "../src/local-providers";
import type { TeamAccount } from "../src/report";

const now = Date.parse("2026-11-05T12:00:00Z");
const reset = "2026-11-08T00:00:00Z";

describe("gravityWindows", () => {
  test("an exhausted bucket without remainingFraction is 100% used, out, and first", () => {
    const windows = gravityWindows(
      [
        { modelId: "gemini-3.8-flash", remainingFraction: 0.5, resetTime: reset },
        { modelId: "claude-opus-5-5", resetTime: reset },
      ],
      now,
    );
    expect(windows.map((w) => [w.name, w.percent, w.state, w.main])).toEqual([["Claude Opus 5.5", 100, "out", true]]);
    expect(windows[0]?.resets_at).toBe(reset);
  });

  test("a model that is not frontier is hidden while it has some left, and shown after the frontier rows once used up", () => {
    const buckets = [
      { modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset },
      { modelId: "claude-sonnet-5-5", remainingFraction: 0.5, resetTime: reset },
      { modelId: "gemini-3.8-flash", remainingFraction: 0.1, resetTime: reset },
    ];
    expect(gravityWindows(buckets, now).map((w) => w.name)).toEqual(["Claude Opus 5.5"]);
    const exhausted = gravityWindows([...buckets, { modelId: "claude-sonnet-5-5", remainingFraction: 0, resetTime: reset }], now);
    expect(exhausted.map((w) => [w.name, w.percent, w.main])).toEqual([
      ["Claude Opus 5.5", 50, true],
      ["Claude Sonnet 5.5", 100, false],
    ]);
    const marked = gravityWindows([...buckets, { modelId: "gemini-3.8-flash", remainingFraction: 1, resetTime: reset, exhausted: true }], now);
    expect(marked.map((w) => w.name)).toEqual(["Claude Opus 5.5", "Gemini 3.8 Flash"]);
  });

  test("the highest version of the frontier tier wins: Opus 5.5 over Opus 4, Argon 4 over Pro 3", () => {
    const opus = gravityWindows(
      [
        { modelId: "claude-opus-4-1", remainingFraction: 0.5, resetTime: reset },
        { modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    );
    expect(opus.map((w) => w.name)).toEqual(["Claude Opus 5.5"]);
    const gemini = gravityWindows(
      [
        { modelId: "gemini-3.8-pro", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gemini-4-argon", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gemini-3-argon", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    );
    expect(gemini.map((w) => w.name)).toEqual(["Gemini 4 Argon"]);
  });

  test("remainingFraction 0 is exhausted, with or without a reset time", () => {
    const windows = gravityWindows([{ modelId: "claude-opus-5-5", remainingFraction: 0 }], now);
    expect(windows).toMatchObject([{ name: "Claude Opus 5.5", percent: 100, state: "out", resets_at: null }]);
  });

  test("an Argon bucket whose reset time has passed is 100% used, even with a fraction", () => {
    const windows = gravityWindows([{ modelId: "gemini-4-argon", remainingFraction: 1, resetTime: "2026-11-01T00:00:00Z" }], now);
    expect(windows).toMatchObject([{ name: "Gemini 4 Argon", percent: 100, state: "out" }]);
  });

  test("a non-Argon bucket whose reset time has passed uses its reported fraction", () => {
    const windows = gravityWindows([{ modelId: "gemini-2.5-pro", remainingFraction: 0.5, resetTime: "2026-11-01T00:00:00Z" }], now);
    expect(windows).toMatchObject([{ name: "Gemini 2.5 Pro", percent: 50, state: "ok" }]);
  });

  test("an exhausted mark is 100% used for any model", () => {
    const windows = gravityWindows([{ modelId: "gemini-2.5-pro", remainingFraction: 1, resetTime: reset, exhausted: true }], now);
    expect(windows[0]?.percent).toBe(100);
  });

  test("a bucket with neither remainingFraction nor resetTime is skipped", () => {
    expect(gravityWindows([{ modelId: "claude-opus-5-5" }], now)).toEqual([]);
  });

  test("effort variants merge into one meter that shows the worst, with its reset", () => {
    const windows = gravityWindows(
      [
        { modelId: "claude-opus-5-5-low", remainingFraction: 0.9, resetTime: "2026-11-06T00:00:00Z" },
        { modelId: "claude-opus-5-5-high", remainingFraction: 0.2, resetTime: "2026-11-07T00:00:00Z" },
        { modelId: "claude-opus-5-5-max", remainingFraction: 0.6, resetTime: "2026-11-08T00:00:00Z" },
      ],
      now,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ name: "Claude Opus 5.5", percent: 80, resets_at: "2026-11-07T00:00:00Z", main: true });
  });

  test("effort variants keep the winning bucket's reset, even when it is null, in either order", () => {
    const worstFirst = gravityWindows(
      [
        { modelId: "claude-opus-5-5-high", remainingFraction: 0.2 },
        { modelId: "claude-opus-5-5-low", remainingFraction: 0.9, resetTime: "less-used" },
      ],
      now,
    );
    const worstLast = gravityWindows(
      [
        { modelId: "claude-opus-5-5-low", remainingFraction: 0.9, resetTime: "less-used" },
        { modelId: "claude-opus-5-5-high", remainingFraction: 0.2 },
      ],
      now,
    );
    expect(worstFirst[0]).toMatchObject({ percent: 80, resets_at: null });
    expect(worstLast[0]).toMatchObject({ percent: 80, resets_at: null });
  });

  test("effort variants take the reset of the worst bucket in either order", () => {
    const worstFirst = gravityWindows(
      [
        { modelId: "claude-opus-5-5-high", remainingFraction: 0.2, resetTime: "worst" },
        { modelId: "claude-opus-5-5-low", remainingFraction: 0.9, resetTime: "less-used" },
      ],
      now,
    );
    const worstLast = gravityWindows(
      [
        { modelId: "claude-opus-5-5-low", remainingFraction: 0.9, resetTime: "less-used" },
        { modelId: "claude-opus-5-5-high", remainingFraction: 0.2, resetTime: "worst" },
      ],
      now,
    );
    expect(worstFirst[0]?.resets_at).toBe("worst");
    expect(worstLast[0]?.resets_at).toBe("worst");
  });

  test("chat_, tab_ and other families are dropped", () => {
    expect(
      gravityWindows(
        [
          { modelId: "chat_abc", remainingFraction: 0.1, resetTime: reset },
          { modelId: "tab_flash", remainingFraction: 0.1, resetTime: reset },
          { modelId: "mistral-large", remainingFraction: 0.1, resetTime: reset },
        ],
        now,
      ),
    ).toEqual([]);
  });

  test("equal buckets still give one window per model, in family order", () => {
    const windows = gravityWindows(
      [
        { modelId: "gpt-oss-120b", remainingFraction: 0.5, resetTime: reset },
        { modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gemini-4-argon", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    );
    expect(windows.map((w) => w.name)).toEqual(["Gemini 4 Argon", "Claude Opus 5.5", "GPT-OSS 120B"]);
    expect(windows.map((w) => w.main)).toEqual([true, false, false]);
  });

  test("names come from the model list without effort suffixes", () => {
    const names = new Map([["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"]]);
    const windows = gravityWindows([{ modelId: "claude-opus-5-5-low", remainingFraction: 0.5, resetTime: reset }], now, names);
    expect(windows.map((w) => w.name)).toEqual(["Claude Opus 5.5"]);
  });

  test("duplicate display names fall back to the model id", () => {
    const names = new Map([
      ["claude-opus-5-5", "Top Model"],
      ["gpt-oss-120b", "Top Model"],
    ]);
    const windows = gravityWindows(
      [
        { modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gpt-oss-120b", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
      names,
    );
    expect(windows.map((w) => w.name).sort()).toEqual(["claude-opus-5-5", "gpt-oss-120b"]);
  });

  test("a display name equal to another model's fallback id still gives unique names, and none is hidden", () => {
    const names = new Map([
      ["claude-opus-5-5", "Top Model"],
      ["gpt-oss-120b", "Top Model"],
      ["claude-sonnet-5-5", "claude-opus-5-5"],
    ]);
    const account = {
      quota: {
        windows: gravityWindows(
          [
            { modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset },
            { modelId: "gpt-oss-120b", remainingFraction: 0.4, resetTime: reset },
            { modelId: "claude-sonnet-5-5", remainingFraction: 0, resetTime: reset },
          ],
          now,
          names,
        ),
      },
    } as unknown as TeamAccount;
    const all = account.quota?.windows.map((w) => w.name) ?? [];
    expect(new Set(all).size).toBe(3);
    expect(all).toContain("claude-opus-5-5");
    expect(limitingWindows(account)).toHaveLength(3);
  });

  test("humanizes model ids when there is no display name", () => {
    const windows = gravityWindows(
      [
        { modelId: "claude-opus-5-5", remainingFraction: 0.1, resetTime: reset },
        { modelId: "gemini-3.8-flash", remainingFraction: 0.1, resetTime: reset },
        { modelId: "gemini-4-argon", remainingFraction: 0.1, resetTime: reset },
        { modelId: "gpt-oss-120b", remainingFraction: 0.1, resetTime: reset },
      ],
      now,
    );
    expect(windows.map((w) => w.name).sort()).toEqual(["Claude Opus 5.5", "GPT-OSS 120B", "Gemini 4 Argon"].sort());
  });

  test("limitingWindows puts the tightest meter first", () => {
    const windows = gravityWindows(
      [
        { modelId: "gemini-3.8-flash", remainingFraction: 0.5, resetTime: reset },
        { modelId: "claude-opus-5-5", remainingFraction: 0.05, resetTime: reset },
        { modelId: "gpt-oss-120b", remainingFraction: 0.8, resetTime: reset },
      ],
      now,
    );
    const account = { quota: { windows } } as unknown as TeamAccount;
    expect(limitingWindows(account).map((w) => w.name)).toEqual(["Claude Opus 5.5", "GPT-OSS 120B"]);
  });
});

describe("gravity probes", () => {
  const secrets = ["sk-live-123", "hunter2", "ya29.made-up", "me@example.com", "hello world", "leaked-deep", "tok-789"];

  test("the quota probe keeps only allowlisted fields and redacts secrets, unknown strings and odd names", () => {
    const raw = {
      apiKey: "sk-live-123",
      password: "hunter2",
      accessToken: "ya29.made-up",
      buckets: [
        {
          modelId: "claude-opus-5-5",
          remainingFraction: 0.4,
          resetTime: "2026-11-08T00:00:00Z",
          exhausted: true,
          secretFlag: true,
          email: "me@example.com",
          note: "hello world",
          nested: { deep: "leaked-deep" },
          "odd name@x": "tok-789",
        },
        { modelId: "me@example.com", remainingFraction: "0.2" },
      ],
    };
    const text = JSON.stringify(probeQuota(raw));
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(probeQuota(raw)).toMatchObject({
      fields: ["apiKey", "password", "accessToken", "buckets"],
      buckets: [
        {
          modelId: "claude-opus-5-5",
          remainingFraction: 0.4,
          resetTime: "2026-11-08T00:00:00Z",
          exhausted: true,
          secretFlag: "[redacted]",
          email: "[redacted]",
          note: "[redacted]",
          nested: "[redacted]",
          "[name]": "[redacted]",
        },
        { modelId: "[redacted]", remainingFraction: "[redacted]" },
      ],
    });
  });

  test("the model probe keeps display names, ids and quota fields, and redacts everything else", () => {
    const raw = {
      token: "tok-789",
      models: {
        "gemini-4-argon": {
          displayName: "Gemini 4 Argon",
          quotaInfo: { remainingFraction: 0, resetTime: "2026-11-08T00:00:00Z", apiKey: "sk-live-123" },
          secret: "hunter2",
        },
        "bad id me@example.com": { displayName: "me@example.com", quotaInfo: { resetTime: "hello world" } },
      },
    };
    const text = JSON.stringify(probeModels(raw));
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(probeModels(raw)).toEqual({
      fields: ["token", "models"],
      models: [
        {
          id: "gemini-4-argon",
          displayName: "Gemini 4 Argon",
          fields: ["displayName", "quotaInfo", "secret"],
          quotaFields: ["remainingFraction", "resetTime", "apiKey"],
          remainingFraction: 0,
          resetTime: "2026-11-08T00:00:00Z",
        },
        {
          id: "[redacted]",
          displayName: "[redacted]",
          fields: ["displayName", "quotaInfo"],
          quotaFields: ["resetTime"],
          remainingFraction: null,
          resetTime: "[redacted]",
        },
      ],
    });
  });
});
