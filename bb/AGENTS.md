# Provider roles

The composer Role control chooses the mode. Call `role_choice` and follow it.

Regular does the work in this session. Orchestrator delegates to that provider's role agents and uses that orchestrator's prompt. Do not copy another provider's model pins.

Prompt generator (`interviewer`, label "Prompt generator") is read-only. It interviews the user with the question card, spawns only `explore` (the provider's explore pin), and shows an Orchestrator prompt in chat; it never starts a thread or writes a file. Its lead model is Claude `claude-opus-5-5` (`~/.claude/agents/interviewer.md`), Copilot `gpt-6.1-sol-medium` (agent `interviewer`, `~/.copilot/agents/interviewer.agent.md`), Cursor `cantrip-interview` on `grok-4.7[reasoning_effort=xhigh,fast=false]`, Codex `gpt-6-luna` at high effort, and Antigravity `gemini-4-argon`. Codex and Antigravity have no agent file, so those pins live only in docs and the composer. Like the Orchestrator's model, the role does not switch the model: the user picks it in the composer.

A review always runs on a provider other than the worker's, except on GitHub Copilot (both `acp-github-copilot-cli` and the SopraSteria `acp-github-copilot-sopra`; each keeps its work on its own account) and Cursor: their work stays inside them and is reviewed there by another vendor's model. The Copilot GPT 6.1 Terra worker gets the Copilot `reviewer` agent on Opus 5.5. The Cursor Grok worker gets `cantrip-review` on Meta's Muse (`muse-wonder`). The `spawn` tool picks it, and when a reviewer hits its provider's quota it moves the review to the next provider in the chain and messages the orchestrator the new reviewer id. Chains, first choice first: a Claude worker gets Gemini 4 Argon (`acp-antigravity`), then the Copilot `reviewer` agent on GPT 6.1 Sol (`gpt-6.1-sol`), then Cursor `cantrip-review`. Codex and Gemini workers get Opus 5.5 second unless it is already first. A Codex worker gets Gemini 4 Argon, then Claude Opus 5.5, then the Copilot `reviewer` agent on `gpt-6.1-sol`. A Gemini worker gets the Copilot `reviewer` agent (Opus 5.5), then Codex on `gpt-6.1-sol`, then Claude Opus 5.5. In-process subagent reviews, with no BB `spawn` tool, still use the provider's own reviewer: Copilot `reviewer` and Cursor `cantrip-review`.

Review is a loop: the reviewer sends defects straight to the worker that wrote the change, and reports to the orchestrator only at the end (`CLEAN` or `ESCALATE`). The user authorized that messaging exception for this loop only; it does not extend to other threads.

Any `bb thread spawn` an agent runs passes `--permission-mode full`, and `--parent-self` unless the thread is meant to be top-level, so spawned threads never fall back to the auto or accept-edits default.

# BB setup repo

This bb's setup is tracked in GitHub `bogxxx/bb-setup`, cloned at `C:\Users\krech\src\bb-setup` on Windows and `~/src/bb-setup` on macOS. If the clone is missing on a host, clone it with the `bogxxx` gh account (`gh auth token --user bogxxx`); do not switch the active gh account, because bb's Copilot integration depends on it. It holds the user's own plugins (`plugins/`, which bb runs from there), user skills, `~/.bb/AGENTS.md`, `~/.claude/CLAUDE.md` and `~/.claude/agents`, the installed plugin list, and non-default plugin settings.

After you change any of these, such as by editing a plugin, adding a skill, installing, removing, enabling or disabling a plugin, or changing a plugin setting, run `powershell -File C:\Users\krech\src\bb-setup\scripts\sync.ps1 -m "<what changed>"` on Windows or `~/src/bb-setup/scripts/sync.sh -m "<what changed>"` on macOS. It captures, commits and pushes. Create new plugins under `plugins/` in that repo, then run `bb plugin install <path>`.
