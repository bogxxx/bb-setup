---
name: propagate-setup-to-machines
description: Push a bb-setup change (new skill, plugin, agent file, AGENTS.md) to every connected bb machine and verify each one. Use after changing the bb-setup repo, or when the user asks to update, sync or populate the setup on all machines.
---

# Propagate the bb setup to all machines

The setup lives in the public GitHub repo `bogxxx/bb-setup`. A change only reaches a machine when that machine pulls the repo and links it. Do these steps without asking the user to re-explain them.

## 1. Publish from this machine
Run the sync script from the local clone (`~/src/bb-setup/scripts/sync.sh -m "<what changed>"` on Linux/macOS, `sync.ps1` on Windows). If the push is rejected, `git pull --rebase`, resolve conflicts (prefer upstream logic, keep both sides' intent), `git push`. If a conflict is in someone else's change and the right side is unclear, ask.

## 2. Find the machines
`bb host list` (use `node "$BB_CLI" ...` if `bb` says permission denied). Skip this host and any that are not `connected`. Ask first only if a host looks like it belongs to a different account.

## 3. One thread per machine
For each other host, spawn exactly one thread (never a duplicate):

`bb thread spawn --project <project id from bb status> --machine <host id> --new-environment personal --parent-self --permission-mode full --prompt-file <file>`

Prompt contents, in short:
- The repo is at `C:\Users\<that user>\src\bb-setup` (Windows; the user name differs per machine, so locate it) or `~/src/bb-setup` (macOS).
- Run sync (`sync.ps1` / `sync.sh`) with `-m "Sync BB setup"`; rerun once if the first run only pulled, so new skill links are created. Stop and report on merge conflicts.
- Verify the new skill or file exists under `~/.bb/skills` (or the relevant live path) and `git status -sb` shows no ahead/behind.
- Do not switch the active gh account.

If a thread errors with "could not find the Claude Code CLI", that machine has no Claude Code: respawn once with another provider (`--provider acp-github-copilot-cli`, or `codex`), not several at once.

## 4. No bogxxx login on a machine
The repo is public, so no login is needed to pull: `git pull --rebase https://github.com/bogxxx/bb-setup.git main`, then `sync.ps1 -NoPush`. Local machine-only commits (for example generated `bb/plugins.json`) that are already upstream can be dropped. If a real change must go up, push with that machine's own gh account to a fork or branch, open a PR against `bogxxx/bb-setup`, then approve and merge it here with the `bogxxx` account (`gh auth token --user bogxxx`, never switch the active account).

## 5. Wait and report
`bb thread wait <id> --timeout 8m` takes one id, so run one per thread. Read `bb thread output <id>`. Report a table: machine, result, anything blocked. Do not repeat completion notices the user already saw.

## Gotchas
- `bb thread spawn` requires `--project`.
- Sync scripts link every folder under `skills/` automatically; an older machine may need a second run to create the link.
- Run sync after editing this repo's skills or plugins, as the user's AGENTS.md requires.
