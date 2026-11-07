---
name: provider-orchestration
description: Route development work through the current provider's orchestrator, explorer, planner, and worker. Copilot reviews run on Opus 5.5. Claude reviews run on Gemini 4 Argon or the Cursor cantrip reviewer. Use for a task larger than a lookup or one-line edit, and when choosing models for Cursor, Claude Code, or GitHub Copilot.
---

# Provider orchestration

The composer Role control chooses regular, orchestrator, or prompt generator. Call `role_choice` and follow it. Regular stays on this thread. Orchestrator follows the provider below. Prompt generator (`interviewer`) interviews the user, spawns only `explore`, and writes a prompt for an Orchestrator thread; its agent files are `interviewer` (Claude, Copilot) and `cantrip-interview` (Cursor).

Detect the provider with `bb thread show $env:BB_THREAD_ID --json` and read `providerId`. The orchestrator file is the system prompt for that role. A lookup stays on the current thread.

## Planning default (every provider)

Planning is the default. Spawn the planner before any worker: the in-process `planner` agent, the Cursor `cantrip-plan`, or the BB `spawn` name `plan`. Sequence for non-trivial work: explore (if needed), plan, contribute, review loop.

The planner designs; it does not diagnose. Finding a root cause, reading CI or job logs, reproducing a failure, and mapping unfamiliar code are exploration: spawn `explore` for them first, then give `plan` the findings (cause, evidence, paths) and ask only for the implementation plan. Never assign "find the root cause and plan the fix" to the planner. A bug with an unknown root cause is explore, then plan.

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

1. Spawn `contribute` (the worker) and end your turn. bb wakes you when it finishes; read `bb thread output <worker>`.
2. Spawn `review` with `worker` set to the worker's thread id. The spawn tool picks the reviewer and its model for the provider, and it appends the loop protocol to the reviewer's prompt. End your turn.
3. Act on the reviewer alone: when bb wakes you for it, read `bb thread output <reviewer>`. Wake-ups from the worker's fix rounds while the reviewer runs need no action.
   - `CLEAN`: the review passed. Run the acceptance checks.
   - `ESCALATE` plus findings: tell the same worker to fix the remaining findings. Do not ask the user whether to continue.

Inside the loop, the reviewer checks the worker's diff. If there are defects, it sends them to the worker in `REVIEW round N/2 from thread:<reviewer id>`. The worker fixes only those findings, runs its checks, and replies `FIXED round N` (or `BLOCKED`) to the reviewer. The worker keeps its context, so it does not start over. The reviewer re-reviews. After round 2, if findings remain, it ends with `ESCALATE`.

The spawn tool sets `parentNotifications: auto` on every spawned thread, so bb wakes the orchestrator when a child ends its turn. The orchestrator must not poll (`bb thread wait` loops, sleeps, heartbeat automations): a wake-up after the prompt cache expired re-sends the whole conversation at cache-write price. On epic #97 in the scour project, a 10-minute `bb thread wait --timeout 590` loop on Opus cost about 92 AIU per wake against about 4 for a warm call, 90% of the orchestrator's usage. The reviewer, which must block inside its turn, waits on the worker with `bb thread wait <worker> --timeout 4m`, repeated, so its cache stays warm.

Messaging exception: the bb guide forbids messaging other threads unless the user asks. The user authorized this loop only: a reviewer may message the worker it reviews, and the worker may reply to that reviewer. No other thread-to-thread messages.

In-process subagents cannot reach a sibling. That covers the Claude Agent tool, Copilot `task`, and Cursor `Task`. There the orchestrator is the relay. It passes the reviewer's findings to the same worker with SendMessage (Claude) or `write_agent` (Copilot), which resumes that worker with its transcript. It does not spawn a new worker to fix while that resume works. If any in-process subagent cannot be resumed, say a fresh worker loses its context, then start it with the findings. Do not ask first. It sends the fix back to the reviewer, for at most two rounds.

If no reviewer is left, do not ask the user. Continue. Commit and propagate on the worker's verification, and say that independent review did not run.

When the work is done and verified, commit, push, open a pull request, and merge. Do not ask permission. For the bb-setup repo, propagation is `~/src/bb-setup/scripts/sync.sh -m "<what changed>"` and then the propagate-setup-to-machines skill. An application repo propagates by merging the pull request. The only hold is an explicit sentence that the user is not allowed to merge before their decision, or not allowed to create pull requests before their decision. Do not infer a hold from silence, from the user not saying "please commit", or from a review being unavailable.

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
