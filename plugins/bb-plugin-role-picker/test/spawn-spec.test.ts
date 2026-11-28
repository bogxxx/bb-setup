import { describe, expect, test } from "bun:test";
import { spawnSpec } from "../server";

describe("claude-code spawn reasoning levels", () => {
  test("explore and contribute run at high effort", () => {
    expect(spawnSpec("claude-code", "explore")).toMatchObject({ providerId: "claude-code", reasoningLevel: "high" });
    expect(spawnSpec("claude-code", "contribute")).toMatchObject({ providerId: "claude-code", reasoningLevel: "high" });
  });

  test("plan pin (fallback) is medium", () => {
    expect(spawnSpec("claude-code", "plan")).toMatchObject({ providerId: "claude-code", reasoningLevel: "medium" });
  });
});
