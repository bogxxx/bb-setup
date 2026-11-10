import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_GEMINI_FALLBACK, reviewChain } from "../server";
import { reviewerModelKey } from "../lib/quota-block";

const pairs = (parent: string) =>
  reviewChain(parent).map((spec) => [spec.providerId, reviewerModelKey(spec)]);

describe("reviewChain", () => {
  test("a Claude worker tries Argon, Copilot Sol, the Gemini fallback, then Cursor", () => {
    expect(pairs("claude-code")).toEqual([
      ["acp-antigravity", "gemini-4-argon"],
      ["acp-github-copilot-cli", "gpt-6.1-sol-medium"],
      ["acp-antigravity", ANTIGRAVITY_GEMINI_FALLBACK],
      ["acp-cursor", "cantrip-review.md"],
    ]);
  });

  test("the Gemini fallback is not the Argon model", () => {
    expect(ANTIGRAVITY_GEMINI_FALLBACK).not.toMatch(/argon/i);
  });

  test("an Antigravity worker gets no Antigravity reviewer", () => {
    expect(pairs("acp-antigravity").map(([provider]) => provider)).not.toContain("acp-antigravity");
  });

  test("Copilot CLI, Copilot Sopra and Codex chains are unchanged", () => {
    expect(pairs("acp-github-copilot-cli")).toEqual([["acp-github-copilot-cli", "claude-opus-5.5-medium"]]);
    expect(pairs("acp-github-copilot-sopra")).toEqual([["acp-github-copilot-sopra", "claude-opus-5.5-medium"]]);
    expect(pairs("codex")).toEqual([
      ["acp-antigravity", "gemini-4-argon"],
      ["claude-code", "claude-opus-5-5"],
      ["acp-github-copilot-cli", "gpt-6.1-sol-medium"],
    ]);
  });
});
