# Claude roles

Call `role_choice` before development work.

Regular is the default thread: it does the work in this session and may use any agents or tools it needs.

Orchestrator follows `~/.claude/agents/orchestrator.md`. Opus 5.5 (`claude-opus-5-5`) leads and plans. Haiku 5.5 (`claude-haiku-5-5`) explores and implements. In-process Agent tool subagents are only `explorer`, `planner`, and `worker`. In BB, the `spawn` tool takes `explore`, `contribute`, `plan`, and `review`.

Prompt generator follows `~/.claude/agents/interviewer.md`. Opus 5.5 (`claude-opus-5-5`) leads; it interviews the user and spawns only `explore`, and it writes a prompt for an Orchestrator thread without editing.

Do not review with Opus or Haiku. A Claude review runs on another provider: Gemini 4 Argon (`gemini-4-argon` on Antigravity, provider `acp-antigravity`) first; if that provider's quota is reached, the Copilot `reviewer` agent on GPT 6.1 Sol (`gpt-6.1-sol`), then Cursor `cantrip-review`. The `spawn` tool does that fallback itself. Inside Cursor, it is `cantrip-review`. Never use the Copilot `reviewer` agent on its default Opus 5.5 model for a Claude review.

Review is a loop: the reviewer sends defects straight to the worker that wrote the change, and reports to the orchestrator only at the end (`CLEAN` or `ESCALATE`). The user authorized that messaging exception for this loop only.
