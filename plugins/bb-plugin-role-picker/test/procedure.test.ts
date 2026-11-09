import { describe, expect, test } from "bun:test";
import { procedure } from "../server";

describe("procedure: how the prompt generator asks", () => {
  test("Copilot pipes the questions into bb plugin run role-picker ask, in bash or powershell", () => {
    for (const providerId of ["acp-github-copilot-cli", "acp-github-copilot-sopra"]) {
      const text = procedure(providerId, "interviewer");
      expect(text).toContain("bb plugin run role-picker ask --questions-stdin <<'EOF'");
      expect(text).toContain("'@ | bb plugin run role-picker ask --questions-stdin");
      expect(text).toContain("read_bash");
      expect(text).toContain("read_powershell");
      expect(text).toContain("initial_wait (600)");
      expect(text).not.toContain("--questions '");
      expect(text).not.toContain("AskUserQuestion tool");
    }
  });

  test("Copilot orchestrator writes the assignment to a file and passes it with --assignment-file", () => {
    for (const providerId of ["acp-github-copilot-cli", "acp-github-copilot-sopra"]) {
      const text = procedure(providerId, "orchestrator");
      expect(text).toContain('cat > "$BB_THREAD_STORAGE/');
      expect(text).toContain("--assignment-file");
      expect(text).not.toContain('--assignment "$(');
    }
  });

  test("other providers keep the AskUserQuestion tool", () => {
    for (const providerId of ["claude-code", "acp-cursor", "codex"]) {
      const text = procedure(providerId, "interviewer");
      expect(text).toContain("Ask through the AskUserQuestion tool");
      expect(text).not.toContain("role-picker ask");
    }
  });
});
