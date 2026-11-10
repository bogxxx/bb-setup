import { describe, expect, test } from "bun:test";
import { quotaNoticeUntil } from "../server";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-11-10T10:00:00Z");

describe("quotaNoticeUntil", () => {
  test("Copilot's monthly quota reply blocks for the default hour", () => {
    const text = "Error: You have exceeded your monthly quota (Request ID: 9F2A-1B3C).";
    expect(quotaNoticeUntil(text, now)).toBe(now + HOUR);
  });

  test("out of quota and quota has been exceeded are notices", () => {
    expect(quotaNoticeUntil("You are out of quota for this model.", now)).toBe(now + HOUR);
    expect(quotaNoticeUntil("The quota has been exceeded.", now)).toBe(now + HOUR);
  });

  test("Antigravity's reset time is read from the notice", () => {
    const text = "⚠ Individual quota reached. Try again later. Resets in 144h15m35s.";
    expect(quotaNoticeUntil(text, now)).toBe(now + 144 * HOUR + 15 * 60_000 + 35_000);
  });

  test("a CLEAN or ESCALATE review is never a notice, even when it mentions quota", () => {
    const review = `CLEAN\n\nChecked the quota block keys and the chain order. ${"No findings. ".repeat(40)}`;
    expect(review.length).toBeGreaterThan(400);
    expect(quotaNoticeUntil(review, now)).toBeNull();
    expect(quotaNoticeUntil("CLEAN. Exceeded the quota check in the diff, no issues.", now)).toBeNull();
  });

  test("a long reply is not a notice", () => {
    const long = `Reviewed the change. The quota reached limit is not touched. ${"x".repeat(400)}`;
    expect(quotaNoticeUntil(long, now)).toBeNull();
  });

  test("ordinary text and empty replies are not notices", () => {
    expect(quotaNoticeUntil("Fixed the parser and ran the tests.", now)).toBeNull();
    expect(quotaNoticeUntil("", now)).toBeNull();
    expect(quotaNoticeUntil(null, now)).toBeNull();
  });
});
