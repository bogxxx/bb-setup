import { describe, expect, test } from "bun:test";
import { blockKey, parseQuotaBlock, quotaBlockEnd, QUOTA_BLOCK_CAP_MS, reviewerModelKey } from "../lib/quota-block";

const HOUR = 60 * 60 * 1000;

describe("quota blocks", () => {
  test("a legacy numeric block is not a block", () => {
    expect(parseQuotaBlock(1_794_359_000_000)).toBeNull();
    expect(parseQuotaBlock(undefined)).toBeNull();
  });

  test("a block with a reset within the cap lasts until that reset", () => {
    const setAt = Date.parse("2026-11-07T10:00:00Z");
    const block = parseQuotaBlock({ until: setAt + HOUR, setAt });
    expect(block).not.toBeNull();
    expect(quotaBlockEnd(block!)).toBe(setAt + HOUR);
  });

  test("a notice that resets in 143h is capped at 6h", () => {
    const setAt = Date.parse("2026-11-07T10:00:00Z");
    const block = parseQuotaBlock({ until: setAt + 143 * HOUR, setAt });
    expect(quotaBlockEnd(block!)).toBe(setAt + QUOTA_BLOCK_CAP_MS);
    expect(setAt + 6 * HOUR - 1).toBeLessThan(quotaBlockEnd(block!));
    expect(setAt + 6 * HOUR + 1).toBeGreaterThan(quotaBlockEnd(block!));
  });
});

describe("block keys", () => {
  test("a provider key has no model, and a model key adds it", () => {
    expect(blockKey("acp-antigravity")).toBe("quota-blocked:acp-antigravity");
    expect(blockKey("acp-antigravity", "gemini-4-argon")).toBe("quota-blocked:acp-antigravity:gemini-4-argon");
  });

  test("a reviewer's key is its model, or its agent file for Cursor", () => {
    expect(reviewerModelKey({ providerId: "acp-antigravity", model: "gemini-4-argon" })).toBe("gemini-4-argon");
    expect(reviewerModelKey({ providerId: "acp-cursor", agent: { name: "cantrip-review.md" } })).toBe("cantrip-review.md");
  });
});
