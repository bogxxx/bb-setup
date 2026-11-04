# Claude roles

Call `role_choice` before development work.

Regular does the work in this session and does not spawn explorer, planner, or worker.

Orchestrator follows `~/.claude/agents/orchestrator.md`. Opus 5.5 (`claude-opus-5-5`) leads and plans. Haiku 5.5 (`claude-haiku-5-5`) explores and implements. In-process Agent tool subagents are only `explorer`, `planner`, and `worker`. In BB, the `spawn` tool takes `explore`, `contribute`, `plan`, and `review`.

Do not review with Opus or Haiku. A Claude review runs on another provider: Gemini 4 Argon (`gemini-4-argon` on Antigravity, provider `acp-antigravity`) first; if that provider's quota is reached, Codex (`gpt-6-luna`), then the Copilot `reviewer` agent on `gpt-6.1-terra`. The `spawn` tool does that fallback itself. Inside Cursor, it is `cantrip-review`. Never use the Copilot `reviewer` agent on its default Opus 5.5 model for a Claude review.

Review is a loop: the reviewer sends defects straight to the worker that wrote the change, and reports to the orchestrator only at the end (`CLEAN` or `ESCALATE`). The user authorized that messaging exception for this loop only.
