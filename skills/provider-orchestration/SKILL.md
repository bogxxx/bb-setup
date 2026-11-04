---
name: provider-orchestration
description: Route development work through the current provider's orchestrator, explorer, planner, and worker. Copilot reviews run on Opus 5.5. Claude reviews run on Gemini 4 Argon or the Cursor cantrip reviewer. Use for a task larger than a lookup or one-line edit, and when choosing models for Cursor, Claude Code, or GitHub Copilot.
---

# Provider orchestration

The composer Role control chooses regular or orchestrator. Call `role_choice` and follow it. Regular stays on this thread. Orchestrator follows the provider below.

Detect the provider with `bb thread show $env:BB_THREAD_ID --json` and read `providerId`. The orchestrator file is the system prompt for that role. A lookup or one obvious one-line edit stays on the current thread.

Model ids below were present in `bb provider models <provider> --environment env_chay9bmgz7` on this machine. Re-check the live catalog before spawning if the catalog may have changed. A spawn override sets provider, model, and reasoning level together. Omitting all three inherits the parent.

## Cursor (`acp-cursor`)

Orchestrator: `~/.cursor/agents/cantrip-goal.md`. It spawns `cantrip-explore`, `cantrip-plan`, `cantrip-implement`, and `cantrip-review`.

Leave these model lines as written:

- cantrip-goal and cantrip-plan: `claude-opus-5-5[effort=medium,fast=false]`
- cantrip-explore and cantrip-implement: `grok-4.7[reasoning_effort=xhigh,fast=false]`
- cantrip-review: `muse-wonder[effort=medium,fast=false]`

Do not replace a bracket pin with a picker slug. The BB Cursor catalog does not list `muse-wonder`, `grok-4.7`, or `claude-opus-5-5`. Those pins are for Cursor's own subagents. Do not pass them to `bb thread spawn --provider acp-cursor`.

Inside Cursor, review with `cantrip-review`.

## GitHub Copilot (`acp-github-copilot-cli`)

Orchestrator: `~/.copilot/agents/orchestrator.agent.md`. It spawns `explorer`, `planner`, `worker`, and `reviewer` from `~/.copilot/agents`. Select session option `agent=orchestrator` when starting a Copilot development thread.

Confirmed catalog ids:

| Role | Model | Reasoning |
| --- | --- | --- |
| orchestrator | `claude-opus-5.5` | medium |
| explorer | `claude-haiku-5.5` | catalog default medium |
| planner | `claude-opus-5.5` | catalog default medium |
| worker | `gpt-6.1-terra` | medium |
| reviewer | `claude-opus-5.5` | medium |

The reviewer tools are view, grep, glob, and skill. It has no shell. The Copilot orchestrator spawns this agent by name. A BB spawn of the same persona sets all three of provider `acp-github-copilot-cli`, model `claude-opus-5.5`, and reasoning level `medium`, plus `--option agent=reviewer`.

## Claude Code (`claude-code`)

Orchestrator: `~/.claude/agents/orchestrator.md`. It spawns only `explorer`, `planner`, and `worker` from `~/.claude/agents`.

Confirmed catalog ids, effort `medium`:

| Role | Model |
| --- | --- |
| orchestrator | `claude-opus-5-5` |
| planner | `claude-opus-5-5` |
| explorer | `claude-haiku-5-5` |
| worker | `claude-haiku-5-5` |

Opus and Haiku do not review Claude work. The review is Gemini 4 Argon (`gemini-4-argon` on Antigravity, provider `acp-antigravity`), or `cantrip-review` when the session is Cursor.

```powershell
bb thread spawn --project $env:BB_PROJECT_ID --parent-self --environment $env:BB_ENVIRONMENT_ID --provider acp-antigravity --model gemini-4-argon --reasoning-level medium --permission-mode full --title "Review" --prompt-file <absolute-path>
bb thread wait <thread-id>
```

Do not pass `--option agent=reviewer` on this spawn. That agent is Opus 5.5. The prompt must tell Argon to review and not edit. Wait for it, because the review gates completion. Allow at most two fix rounds.

## Any other provider

Explore, plan, and implement with models from that provider's live catalog. Send the review to the Antigravity Argon reviewer persona: provider `acp-antigravity`, model `gemini-4-argon`, reasoning level `medium`, `--option agent=reviewer`. Do not invent a model id.
