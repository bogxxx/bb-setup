# Provider roles

The composer Role control chooses the mode. Call `role_choice` and follow it.

Regular does the work in this session. Orchestrator delegates to that provider's role agents and uses that orchestrator's prompt. Do not copy another provider's model pins.

On GitHub Copilot, the reviewer agent is Opus 5.5 (`claude-opus-5.5`). On Claude, a review is Gemini 4 Argon (`gemini-4-argon` on Antigravity, provider `acp-antigravity`) or, inside Cursor, `cantrip-review`. On Cursor, the orchestrator's review is `cantrip-review`.

# BB setup repo

This bb's setup is tracked in GitHub `bogxxx/bb-setup`, cloned at `C:\Users\krech\src\bb-setup` on Windows and `~/src/bb-setup` on macOS. If the clone is missing on a host, clone it with the `bogxxx` gh account (`gh auth token --user bogxxx`); do not switch the active gh account, because bb's Copilot integration depends on it. It holds the user's own plugins (`plugins/`, which bb runs from there), user skills, `~/.bb/AGENTS.md`, `~/.claude/CLAUDE.md` and `~/.claude/agents`, the installed plugin list, and non-default plugin settings.

After you change any of these, such as by editing a plugin, adding a skill, installing, removing, enabling or disabling a plugin, or changing a plugin setting, run `powershell -File C:\Users\krech\src\bb-setup\scripts\sync.ps1 -m "<what changed>"` on Windows or `~/src/bb-setup/scripts/sync.sh -m "<what changed>"` on macOS. It captures, commits and pushes. Create new plugins under `plugins/` in that repo, then run `bb plugin install <path>`.
