import { describe, expect, test } from "bun:test";
import { cardWindows, limitingWindows } from "../src/format";
import {
  gravityAgyWindows,
  gravitySummaryWindows,
  gravityWindows,
  joinGravityWindows,
  parseAgyCredential,
  parseAgyQuota,
  probeModels,
  probeQuota,
  probeSummary,
} from "../src/local-providers";
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
    expect(windows.map((w) => [w.name, w.percent, w.state, w.main])).toEqual([
      ["Claude Opus 5.5", 100, "out", true],
      ["Gemini 3.8 Flash", 50, "ok", false],
    ]);
    expect(windows[0]?.resets_at).toBe(reset);
  });

  test("a model that is not frontier is hidden while it has some left, and shown after the frontier rows once used up", () => {
    const buckets = [
      { modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset },
      { modelId: "claude-sonnet-5-5", remainingFraction: 0.5, resetTime: reset },
      { modelId: "gemini-3.1-flash-lite", remainingFraction: 0.1, resetTime: reset },
    ];
    expect(gravityWindows(buckets, now).map((w) => w.name)).toEqual(["Claude Opus 5.5"]);
    const exhausted = gravityWindows([...buckets, { modelId: "claude-sonnet-5-5", remainingFraction: 0, resetTime: reset }], now);
    expect(exhausted.map((w) => [w.name, w.percent, w.main])).toEqual([
      ["Claude Opus 5.5", 50, true],
      ["Claude Sonnet 5.5", 100, false],
    ]);
    const marked = gravityWindows([...buckets, { modelId: "gemini-3.1-flash-lite", remainingFraction: 1, resetTime: reset, exhausted: true }], now);
    expect(marked.map((w) => w.name)).toEqual(["Claude Opus 5.5", "Gemini 3.1 Flash Lite"]);
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
    expect(limitingWindows(account).map((w) => w.name)).toEqual(["Claude Opus 5.5", "Gemini 3.8 Flash", "GPT-OSS 120B"]);
  });
});

describe("frontier models, with the buckets a real account returns", () => {
  const real = [
    "gemini-2.5-pro",
    "gemini-3-flash",
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash-tiered",
    "gemini-2.5-flash",
    "gemini-2.5-flash-preview",
    "gemini-3.5-flash-lite",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "gpt-oss-120b",
  ].map((modelId) => ({ modelId, remainingFraction: 0.5, resetTime: reset }));

  test("the card shows the newest Gemini flash, Opus and GPT, and nothing else that is not used up", () => {
    expect(gravityWindows(real, now).map((w) => w.name)).toEqual(["Gemini 3.8 Flash", "Claude Opus 5.5", "GPT-OSS 120B"]);
  });

  test("a used-up model that is not frontier is shown after the frontier rows", () => {
    const windows = gravityWindows([...real, { modelId: "gemini-2.5-pro", remainingFraction: 0, resetTime: reset }], now);
    expect(windows.map((w) => [w.name, w.main])).toEqual([
      ["Gemini 3.8 Flash", true],
      ["Claude Opus 5.5", false],
      ["GPT-OSS 120B", false],
      ["Gemini 2.5 Pro", false],
    ]);
  });

  test("the newest generation wins over a higher tier of an older one", () => {
    const names = gravityWindows(
      [
        { modelId: "gemini-2.5-pro", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gemini-3.8-flash", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    ).map((w) => w.name);
    expect(names).toEqual(["Gemini 3.8 Flash"]);
  });

  test("versions compare as integer segments: 3.10 is newer than 3.8, and 3-8 is 3.8", () => {
    const newer = gravityWindows(
      [
        { modelId: "gemini-3.8-pro", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gemini-3.10-pro", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    );
    expect(newer.map((w) => w.name)).toEqual(["Gemini 3.10 Pro"]);
    const same = gravityWindows(
      [
        { modelId: "gemini-3-8-pro", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gemini-3.8-pro", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    );
    expect(same).toHaveLength(2);
  });

  test("a parameter count is not a version: gpt-6 outranks gpt-oss-120b", () => {
    const windows = gravityWindows(
      [
        { modelId: "gpt-oss-120b", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gpt-6", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    );
    expect(windows.map((w) => w.name)).toEqual(["GPT 6"]);
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

describe("Gravity Argon row and the card", () => {
  const accountOf = (windows: ReturnType<typeof gravityWindows>) => ({ quota: { windows } }) as unknown as TeamAccount;

  test("a real Argon row is first and main, even when another row is more used", () => {
    const windows = gravityWindows(
      [
        { modelId: "claude-opus-5-5", remainingFraction: 0.1, resetTime: reset },
        { modelId: "gemini-4-argon", remainingFraction: 0.9, resetTime: reset },
      ],
      now,
    );
    expect(windows.map((w) => [w.name, w.main])).toEqual([
      ["Gemini 4 Argon", true],
      ["Claude Opus 5.5", false],
    ]);
  });

  test("a flash model and its -tiered twin keep unique names", () => {
    const names = gravityWindows(
      [
        { modelId: "gemini-3.8-flash", remainingFraction: 0.5, resetTime: reset },
        { modelId: "gemini-3.8-flash-tiered", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    ).map((w) => w.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(2);
  });

  test("with no Argon reading the card has no placeholder row: it shows the readings it has", () => {
    const account = accountOf(gravityWindows([{ modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset }], now));
    expect(cardWindows("antigravity", account).map((w) => [w.name, w.main, w.unread])).toEqual([["Claude Opus 5.5", true, false]]);
    expect(limitingWindows(account).map((w) => w.name)).toEqual(["Claude Opus 5.5"]);
    expect(cardWindows("antigravity", accountOf([]))).toEqual([]);
  });

  test("the summary's shared limits become Claude & GPT rows; missing or junk values add nothing", () => {
    const raw = {
      groups: [
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-11-14T21:30:37Z", remainingFraction: 0.75 },
            { bucketId: "3p-5h", window: "5h", resetTime: "2026-11-08T02:30:37Z", remainingFraction: 0 },
          ],
        },
      ],
    };
    expect(gravitySummaryWindows(raw, now).map((w) => [w.name, w.percent, w.resets_at, w.main])).toEqual([
      ["Claude & GPT · weekly", 25, "2026-11-14T21:30:37Z", false],
      ["Claude & GPT · 5-hour", 100, "2026-11-08T02:30:37Z", false],
    ]);
    expect(gravitySummaryWindows(null, now)).toEqual([]);
    expect(gravitySummaryWindows({ groups: "nope" }, now)).toEqual([]);
    expect(gravitySummaryWindows({ groups: [{ buckets: [{ bucketId: "3p-5h", remainingFraction: "0.5" }] }] }, now)).toEqual([]);
    const reset = gravitySummaryWindows({ groups: [{ buckets: [{ bucketId: "3p-5h", resetTime: "2026-11-08T02:30:37Z" }] }] }, now);
    expect(reset.map((w) => w.percent)).toEqual([100]);
  });

  test("the summary probe keeps names, reset times and fractions, and redacts other text", () => {
    const text = JSON.stringify(probeSummary({ groups: [{ displayName: "Claude and GPT models", description: "hunter2", buckets: [{ bucketId: "3p-5h", remainingFraction: 1, resetTime: "2026-11-08T02:30:37Z", token: "secret-value" }] }] }));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret-value");
    expect(text).toContain("Claude and GPT models");
    expect(text).toContain("3p-5h");
  });
});

describe("agy /quota rows", () => {
  // The exact output of `agy -p "/quota"` (agy 1.5.3), tab-separated.
  const sample = [
    "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-14T21:50:50Z",
    "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-08T02:50:50Z",
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-14T21:50:50Z",
    "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-08T02:50:50Z",
    "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t49%\t2026-11-14T18:36:11Z",
  ].join("\n");

  test("the sample parses into one row per line, percent left and reset kept as printed", () => {
    expect(parseAgyQuota(sample)).toEqual([
      { category: "Gemini Models", label: "Weekly Limit Remaining", remaining: 100, resetsAt: "2026-11-14T21:50:50Z" },
      { category: "Gemini Models", label: "Five Hour Limit Remaining", remaining: 100, resetsAt: "2026-11-08T02:50:50Z" },
      { category: "Claude and GPT models", label: "Weekly Limit Remaining", remaining: 100, resetsAt: "2026-11-14T21:50:50Z" },
      { category: "Claude and GPT models", label: "Five Hour Limit Remaining", remaining: 100, resetsAt: "2026-11-08T02:50:50Z" },
      { category: "Gemini 4 Argon", label: "Gemini 4 Argon Weekly Limit", remaining: 49, resetsAt: "2026-11-14T18:36:11Z" },
    ]);
  });

  test("garbage, partial and unreadable lines are skipped or keep only what they state", () => {
    const text = [
      "",
      "agy: some banner",
      "Gemini Models",
      "Gemini Models\tWeekly Limit Remaining",
      "Gemini Models\tWeekly Limit Remaining\t",
      "Gemini Models\tWeekly Limit Remaining\tabc%\t2026-11-14T21:50:50Z",
      "Gemini Models\tWeekly Limit Remaining\t150%\t2026-11-14T21:50:50Z",
      "\tWeekly Limit Remaining\t40%\t2026-11-14T21:50:50Z",
      "Gemini 4 Argon\t\t30%",
      "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t30%\tnot-a-time",
      "Claude and GPT models\tFive Hour Limit Remaining\t 80% \t2026-11-08T02:50:50Z\r",
    ].join("\n");
    expect(parseAgyQuota(text)).toEqual([
      { category: "Gemini 4 Argon", label: "Gemini 4 Argon Weekly Limit", remaining: 30, resetsAt: null },
      { category: "Claude and GPT models", label: "Five Hour Limit Remaining", remaining: 80, resetsAt: "2026-11-08T02:50:50Z" },
    ]);
    expect(parseAgyQuota("")).toEqual([]);
  });

  test("the windows put Argon first and main, then each category's 5-hour limit before its weekly one", () => {
    const windows = gravityAgyWindows(parseAgyQuota(sample));
    expect(windows.map((w) => [w.name, w.percent, w.resets_at, w.main])).toEqual([
      ["Gemini 4 Argon · weekly", 51, "2026-11-14T18:36:11Z", true],
      ["Gemini · 5-hour", 0, "2026-11-08T02:50:50Z", false],
      ["Gemini · weekly", 0, "2026-11-14T21:50:50Z", false],
      ["Claude & GPT · 5-hour", 0, "2026-11-08T02:50:50Z", false],
      ["Claude & GPT · weekly", 0, "2026-11-14T21:50:50Z", false],
    ]);
  });

  test("a new limit row becomes a window by itself, and a repeated name is dropped", () => {
    const text = `${sample}\nGemini 5 Flash\tGemini 5 Flash Five Hour Limit Remaining\t80%\t2026-11-08T02:50:50Z\nGemini 5 Flash\tGemini 5 Flash Five Hour Limit Remaining\t10%\t2026-11-08T02:50:50Z`;
    const names = gravityAgyWindows(parseAgyQuota(text)).map((w) => [w.name, w.percent]);
    expect(names).toEqual([
      ["Gemini 4 Argon · weekly", 51],
      ["Gemini · 5-hour", 0],
      ["Gemini · weekly", 0],
      ["Claude & GPT · 5-hour", 0],
      ["Claude & GPT · weekly", 0],
      ["Gemini 5 Flash · 5-hour", 20],
    ]);
  });

  test("with no agy rows the card keeps retrieveUserQuota's Argon row as main", () => {
    const models = gravityWindows([{ modelId: "gemini-4-argon", remainingFraction: 0.5, resetTime: reset }], now);
    const joined = joinGravityWindows([], models, []);
    expect(joined.map((w) => [w.name, w.main])).toEqual([["Gemini 4 Argon", true]]);
  });

  test("agy's rows win: one Argon row, no duplicate Claude & GPT rows, and the model rows follow", () => {
    const agy = gravityAgyWindows(parseAgyQuota(sample));
    const models = gravityWindows(
      [
        { modelId: "gemini-4-argon", remainingFraction: 0.9, resetTime: reset },
        { modelId: "claude-opus-5-5", remainingFraction: 0.5, resetTime: reset },
      ],
      now,
    );
    const shared = gravitySummaryWindows({
      groups: [{ buckets: [{ bucketId: "3p-weekly", resetTime: reset, remainingFraction: 1 }, { bucketId: "3p-5h", resetTime: reset, remainingFraction: 0.5 }] }],
    }, now);
    const joined = joinGravityWindows(agy, models, shared);
    expect(joined.map((w) => [w.name, w.percent, w.main])).toEqual([
      ["Gemini 4 Argon · weekly", 51, true],
      ["Gemini · 5-hour", 0, false],
      ["Gemini · weekly", 0, false],
      ["Claude & GPT · 5-hour", 0, false],
      ["Claude & GPT · weekly", 0, false],
      ["Claude Opus 5.5", 50, false],
    ]);
  });
});

describe("parseAgyCredential", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const credential = (expiry: string) => ({
    token: { access_token: "ya29.access", refresh_token: "1//refresh", expiry, token_type: "Bearer" },
    auth_method: "oauth",
    id_token_email: "someone@example.com",
  });

  test("reads plain JSON, the go-keyring base64 form and hex, the same way", () => {
    const json = JSON.stringify(credential("2026-11-08T12:00:00Z"));
    const plain = parseAgyCredential(json, now);
    expect(plain).toEqual({ email: "someone", access: "ya29.access", refresh: "1//refresh" });
    expect(parseAgyCredential(`go-keyring-base64:${Buffer.from(json).toString("base64")}`, now)).toEqual(plain);
    expect(parseAgyCredential(Buffer.from(json).toString("hex"), now)).toEqual(plain);
  });

  test("an expired access token is dropped, but its refresh token is kept", () => {
    expect(parseAgyCredential(JSON.stringify(credential("2026-11-07T11:00:00Z")), now)).toEqual({
      email: "someone",
      access: null,
      refresh: "1//refresh",
    });
  });

  test("junk and an empty token give nothing", () => {
    expect(parseAgyCredential("not json", now)).toBeNull();
    expect(parseAgyCredential("{}", now)).toEqual({ email: null, access: null, refresh: null });
  });
});

