import { describe, expect, test } from "bun:test";
import { procedure } from "../server";

describe("procedure: how the prompt generator asks", () => {
  test("Copilot asks with bb roles ask", () => {
    for (const providerId of ["acp-github-copilot-cli", "acp-github-copilot-sopra"]) {
      const text = procedure(providerId, "interviewer");
      expect(text).toContain("bb roles ask --questions");
      expect(text).toContain("initial_wait");
      expect(text).not.toContain("AskUserQuestion tool");
    }
  });

  test("other providers keep the AskUserQuestion tool", () => {
    for (const providerId of ["claude-code", "acp-cursor", "codex"]) {
      const text = procedure(providerId, "interviewer");
      expect(text).toContain("Ask through the AskUserQuestion tool");
      expect(text).not.toContain("bb roles ask");
    }
  });
});
