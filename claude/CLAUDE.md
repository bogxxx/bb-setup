# Claude roles

Call `role_choice` before development work.

Regular does the work in this session and does not spawn explorer, planner, or worker.

Orchestrator follows `~/.claude/agents/orchestrator.md`. Opus 5.5 (`claude-opus-5-5`) leads and plans. Haiku 5.5 (`claude-haiku-5-5`) explores and implements. Spawn only `explorer`, `planner`, and `worker`.

Do not review with Opus or Haiku. A Claude review is Gemini 4 Argon (`gemini-4-argon` on Antigravity, provider `acp-antigravity`) or, inside Cursor, `cantrip-review`. Do not use the Copilot `reviewer` agent for that review; that agent is Opus 5.5.
