---
name: provider-orchestration
description: Route development work through the current provider's orchestrator, explorer, planner, and worker. Copilot reviews run on Opus 5.5. Claude reviews run on Gemini 4 Argon or the Cursor cantrip reviewer. Use for a task larger than a lookup or one-line edit, and when choosing models for Cursor, Claude Code, or GitHub Copilot.
---

# Provider orchestration

The composer Role control chooses regular, orchestrator, or prompt generator. Call `role_choice` and follow it. Regular stays on this thread. Orchestrator follows the provider below. Prompt generator (`interviewer`) interviews the user, spawns only `explore`, and writes a prompt for an Orchestrator thread; its agent files are `interviewer` (Claude, Copilot) and `cantrip-interview` (Cursor).

Detect the provider with `bb thread show $env:BB_THREAD_ID --json` and read `providerId`. The orchestrator file is the system prompt for that role. A lookup stays on the current thread.

## Planning default (every provider)

Planning is the default. Spawn the planner before any worker: the in-process `planner` agent, the Cursor `cantrip-plan`, or the BB `spawn` name `plan`. Sequence for non-trivial work: explore (if needed), plan, contribute, review loop.

Skip the planner only when ALL of these hold: the change is small (about one file or a few lines); the request is unambiguous; the approach is obvious with no design choices; and no exploration is needed to know where or what to edit. State the skip in one line with the reason. When in doubt, plan. Multi-file changes, new features, refactors, bug fixes with an unknown root cause, and changes that touch behavior across components always get a plan.

Model ids below were present in `bb provider models <provider> --environment env_chay9bmgz7` on this machine. Re-check the live catalog before spawning if the catalog may have changed. A spawn override sets provider, model, and reasoning level together. Omitting all three inherits the parent.

## Review rule

The reviewer is always a different model family from the worker that wrote the code. Its blind spots should not match the worker's.

| Provider | Worker | Reviewer |
| --- | --- | --- |
| Cursor | Grok 4.7 | Meta Muse (`cantrip-review`) |
| GitHub Copilot | GPT 6.1 Terra | Claude Opus 5.5 (`reviewer`) |
| Claude Code | Claude Haiku 5.5 | Gemini 4 Argon (Antigravity) |

## Review loop (every provider)

The reviewer and the worker fix defects together. The reviewer does not report each defect to the orchestrator. The orchestrator does this:

1. Spawn `contribute` (the worker), then wait for its report: `bb thread wait <worker>`, then `bb thread output <worker>`.
2. Spawn `review` with `worker` set to the worker's thread id. The spawn tool picks the reviewer and its model for the provider, and it appends the loop protocol to the reviewer's prompt.
3. Wait on the reviewer alone: `bb thread wait <reviewer>`, then read `bb thread output <reviewer>`.
   - `CLEAN`: the review passed. Run the acceptance checks.
   - `ESCALATE` plus findings: decide what to do next. Tell the same worker, or ask the user.

Inside the loop, the reviewer checks the worker's diff. If there are defects, it sends them to the worker in `REVIEW round N/2 from thread:<reviewer id>`. The worker fixes only those findings, runs its checks, and replies `FIXED round N` (or `BLOCKED`) to the reviewer. The worker keeps its context, so it does not start over. The reviewer re-reviews. After round 2, if findings remain, it ends with `ESCALATE`.

The spawn tool sets `parentNotifications: stuck` on `contribute` and `review`, so the orchestrator reads their reports with `bb thread wait` and `bb thread output`. `explore` and `plan` are unchanged.

Messaging exception: the bb guide forbids messaging other threads unless the user asks. The user authorized this loop only: a reviewer may message the worker it reviews, and the worker may reply to that reviewer. No other thread-to-thread messages.

In-process subagents cannot reach a sibling. That covers the Claude Agent tool, Copilot `task`, and Cursor `Task`. There the orchestrator is the relay. It passes the reviewer's findings to the same worker with SendMessage (Claude) or `write_agent` (Copilot), which resumes that worker with its transcript. It does not spawn a new worker to fix. It sends the fix back to the reviewer, for at most two rounds. On Cursor, if a Task subagent cannot be resumed, say so and ask the user.

## Cursor (`acp-cursor`)

Orchestrator: `~/.cursor/agents/cantrip-goal.md`. It spawns `cantrip-explore`, `cantrip-plan`, `cantrip-implement`, and `cantrip-review`.

Prompt generator: `~/.cursor/agents/cantrip-interview.md`, model `grok-4.7[reasoning_effort=xhigh,fast=false]`, readonly. It asks questions one at a time and delegates repository questions only to `cantrip-explore`.

Leave these model lines as written:

- cantrip-goal and cantrip-plan: `claude-opus-5-5[effort=medium,fast=false]`
- cantrip-explore and cantrip-implement: `grok-4.7[reasoning_effort=xhigh,fast=false]`
- cantrip-review: `muse-wonder[effort=medium,fast=false]`

Do not replace a bracket pin with a picker slug. The BB Cursor catalog does not list `muse-wonder`, `grok-4.7`, or `claude-opus-5-5`. Those pins are for Cursor's own subagents. Do not pass them to `bb thread spawn --provider acp-cursor`.

Inside Cursor, review with `cantrip-review`.

## GitHub Copilot (`acp-github-copilot-cli` and `acp-github-copilot-sopra`)

There are two Copilot providers: `acp-github-copilot-cli` (the user's own account, launcher `copilot-acp`) and `acp-github-copilot-sopra` (the SopraSteria account, launcher `copilot-acp-sopra`). They share the launcher, agents, model ids, and rules below; only the gh login differs. A thread on one Copilot spawns its explorer, planner, worker, and reviewer on that same Copilot, and never on the other account.

Orchestrator: `~/.copilot/agents/orchestrator.agent.md`. It spawns `explorer`, `planner`, `worker`, and `reviewer` from `~/.copilot/agents`. Select session option `agent=orchestrator` when starting a Copilot development thread.

Prompt generator: `~/.copilot/agents/interviewer.agent.md` (`agent=interviewer`), model `gpt-6.1-sol-medium`, reasoning `medium`. It spawns only `explorer`.

Confirmed catalog ids, all on the 1M context tier:

| Role | Model | Reasoning |
| --- | --- | --- |
| orchestrator | `claude-opus-5.5-medium` | medium |
| explorer | `claude-haiku-5.5-medium` | medium |
| planner | `claude-opus-5.5-medium` | medium |
| worker | `gpt-6.1-terra-medium` | medium |
| reviewer | `claude-opus-5.5-medium` | medium |
| interviewer (prompt generator) | `gpt-6.1-sol-medium` | medium |

When you start or spawn a Copilot thread with a model, use the 1M catalog id, which carries a `-medium` suffix and no `-standard` (`gpt-6.1-terra-medium`, `claude-opus-5.5-medium`, `claude-haiku-5.5-medium`), and set the effort with the reasoning level. A bare id such as `gpt-6.1-terra` is not in the catalog and the thread silently falls back to `auto`. A `-standard` id runs the 200k tier. The bare ids in `~/.copilot/agents/*.agent.md` front matter are Copilot's own and stay bare.

The reviewer tools are view, grep, glob, skill, bash, and powershell. Its shell is only for `bb thread tell`, `bb thread wait`, `bb thread output`, `bb status`, and read-only git and diff commands. It does not edit. The Copilot orchestrator spawns this agent by name. The BB `spawn` tool with name `review` sets provider `acp-github-copilot-cli`, model `claude-opus-5.5-medium`, reasoning level `medium`, and `--option agent=reviewer`.

## Claude Code (`claude-code`)

Orchestrator: `~/.claude/agents/orchestrator.md`. In BB it calls the `spawn` tool with `explore`, `contribute`, `plan`, and `review`. Its in-process Agent tool subagents are `explorer`, `planner`, and `worker` from `~/.claude/agents`.

Confirmed catalog ids, effort `medium`:

| Role | Model |
| --- | --- |
| orchestrator | `claude-opus-5-5` |
| interviewer (prompt generator) | `claude-opus-5-5` |
| planner | `claude-opus-5-5` |
| explorer | `claude-haiku-5-5` |
| worker | `claude-haiku-5-5` |

Opus and Haiku do not review Claude work. The review is Gemini 4 Argon (`gemini-4-argon` on Antigravity, provider `acp-antigravity`), or `cantrip-review` when the session is Cursor.

Spawn the review with the `spawn` tool, name `review`, and `worker` set to the contribute thread id. The tool sets provider `acp-antigravity`, model `gemini-4-argon`, and reasoning level `medium`. Do not pass `--option agent=reviewer` (that is the Copilot persona, Opus 5.5), and do not run `bb thread spawn` for the review, because that skips the loop protocol. Allow at most two fix rounds (see Review loop).

## Any other provider

Explore, plan, and implement with models from that provider's live catalog. Do not invent a model id. Follow the review rule: the reviewer's family must differ from the worker's.

- Worker is not Gemini: review with Gemini 4 Argon, through the `spawn` tool with name `review` as in Claude Code.
- Worker is Gemini, for example on Antigravity: the `spawn` tool with name `review` on an Antigravity parent uses the Copilot reviewer persona (provider `acp-github-copilot-cli`, model `claude-opus-5.5-medium`, reasoning level `medium`, `agent=reviewer`). Do not pass `--option agent=reviewer` yourself.

The `spawn` tool maps `review` for Claude Code, GitHub Copilot, Cursor, and Antigravity parents. For any other parent, `spawn review` runs on the parent's own provider, which is the worker's family, so do not use it for review. Use `bb thread spawn` with the provider and options above, pass `--parent-self`, `--permission-mode full`, and `--parent-notifications stuck`, and write the loop protocol into the prompt yourself: the `REVIEW round` message to the worker, the two-round limit, and the `CLEAN` and `ESCALATE` endings. Say in the report that you did this.
