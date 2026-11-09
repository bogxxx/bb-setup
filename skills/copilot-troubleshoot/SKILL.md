---
name: copilot-troubleshoot
description: Troubleshoot and fix GitHub Copilot in bb on macOS (Windows equivalents noted). Use when Copilot threads fail, the model picker shows "Could not load model(s) for GitHub Copilot", the copilot CLI is missing or broken, copilot-acp is missing or dangling, a preToolUse hook fails closed with exit 127 so every tool is denied, a Copilot agent pin is unavailable and falls back to another model, or attachments fail with "Refusing to fetch project attachment over insecure server URL: http://…" because the bb server URL is plain HTTP.
---

# Troubleshoot GitHub Copilot in bb

Work through the checks in order. Each check is independent, but a later failure can be a symptom of an earlier one. Start with the read-only script, which prints PASS or FAIL for checks 1 to 5 and writes nothing:

```sh
sh ~/src/bb-setup/skills/copilot-troubleshoot/scripts/check.sh
```

Run it from the bb-setup repo path or the linked skill path (`~/.bb/skills/copilot-troubleshoot/scripts/check.sh`). It exits 1 when any check fails. Use the sections below for the detail behind each FAIL. The script does not run the Copilot CLI with a prompt, so it makes no model calls.

## Rules

- Never run `gh auth switch`. The active gh account `bohdan-krechko-akerbp` is the Copilot seat. The `bogxxx` account is used only for the bb-setup repo, through `gh auth token --user bogxxx`.
- Do not run `~/src/ai-agents-setup` `install.sh` blindly. Read it first.
- Never run `scripts/sync.sh` while the bb-setup working tree has deleted tracked files. It would commit and push the deletions.
- Restarting bb kills running threads. Ask the user before restarting it.
- After you change a file in bb-setup (agent pins, launcher, hooks), run `scripts/sync.sh -m "<what changed>"`.

## 1. Copilot CLI binary

Symptom: the CLI does not start, or `copilot` is not found. The Homebrew symlink can dangle into an empty Caskroom version folder.

```sh
copilot --version
ls -l /opt/homebrew/bin/copilot
ls /opt/homebrew/Caskroom/copilot-cli/
```

Expected: `copilot --version` prints `GitHub Copilot CLI <ver>`. The symlink target exists and the Caskroom folder holds that version.

Fix (incident 2026-11-09: `/opt/homebrew/bin/copilot` pointed at an empty `/opt/homebrew/Caskroom/copilot-cli/<ver>/`):

```sh
brew reinstall --cask copilot-cli
copilot --version
```

Windows: `Get-Command copilot` and `copilot --version`. If it is missing or broken, reinstall it through the same channel that installed it. This channel was not verified on Windows.

## 2. copilot-acp launcher and deleted repo files

Symptom: bb cannot start the Copilot ACP provider. The launcher `~/.local/bin/copilot-acp` is a symlink to `~/src/bb-setup/bb/bin/copilot-acp`, and it dangles when tracked files were deleted from the bb-setup working tree (incident 2026-11-09).

```sh
test -e ~/.local/bin/copilot-acp && echo OK || echo DANGLING
git --no-optional-locks -C ~/src/bb-setup status --short
```

`--no-optional-locks` keeps status from writing the git index. Expected: `OK`, and no line with a `D` in either of its first two columns. That covers unstaged deletions (` D`) and staged deletions (`D `, which `git status` shows after `git rm` or an index-only delete).

Fix: first confirm each deletion is accidental. Ask the user if you are not sure, because a removed plugin or skill can be intentional. Then restore only the named paths from HEAD:

- Unstaged deletion (` D`): `git -C ~/src/bb-setup checkout -- <path>`
- Staged deletion (`D `): `git checkout -- <path>` cannot restore it, because the path is gone from the index. Use `git -C ~/src/bb-setup restore --source=HEAD --staged --worktree -- <path>`.

Before either restore, check that the path has no other uncommitted changes: `git -C ~/src/bb-setup diff -- <path>` and `git -C ~/src/bb-setup diff --cached -- <path>`. The restore commands overwrite only the named paths, so run them one path at a time and do not pass directories you have not checked.

Verify: `test -e ~/.local/bin/copilot-acp && echo OK`, and rerun the status command. Do not run `sync.sh` until status shows no deletions.

Windows: `copilot-acp.cmd` is in `C:\Users\krech\src\bb-setup\bb\bin`. Check it with `Test-Path`, and use the same `git -C C:\Users\krech\src\bb-setup status --short` check. Restore with the same staged/unstaged split as above, after the same confirmation: `git checkout -- <path>` for an unstaged deletion (` D`), and `git restore --source=HEAD --staged --worktree -- <path>` for a staged deletion (`D `).

## 3. Model list (`Could not load model(s) for GitHub Copilot`)

The failure can come from any bb host, not only this Mac. An unscoped `bb provider models acp-github-copilot-cli` reports the bb server host's result (here `oracle`), not this Mac's, so check each machine separately.

```sh
bb machine list
bb provider models acp-github-copilot-cli
```

The bb provider host replaces list-command errors with the generic message "ACP model list command failed to provide a model catalog". Test the launcher on the failing host directly, not through bb. Run these on that host:

```sh
ls -la ~/.cache/bb-copilot-acp/
gh auth status
gh auth token --user bohdan-krechko-akerbp >/dev/null; echo rc=$?
copilot-acp --list-models; echo rc=$?
```

Expected: `models-v2.txt` is present, the akerbp token exists (`rc=0`, or Copilot has its own valid login; see the token note above), and the list prints about 180 lines, each `id - Name`, for example `claude-sonnet-5.5-medium - Claude Sonnet 5.5 (936k) Medium`, with `rc=0`.

How the launcher behaves: it serves a cache under 24 hours old. Otherwise it probes live. A successful live probe writes the cache, so a missing cache does not by itself cause a failure. It exits 1 only when the live probe fails and there is no usable fallback cache. Use `copilot-acp --list-models --refresh` to force a live probe.

Diagnose the gh token with care. `gh auth token --user bohdan-krechko-akerbp` failing does not by itself mean authentication is broken. The launcher's copilotEnv falls back to Copilot's own login. Treat the missing token as the cause only when `copilot-acp --list-models` also fails on that host and Copilot has no valid login of its own.

Other cases:
- `spawn copilot-acp-sopra ENOENT`, or `missing_executable`: that host lacks the `copilot-acp-sopra` launcher in `~/.local/bin`. Link it the same way as `copilot-acp` in bb-setup.
- A bb restart does not help here. Provider bridges are spawned per call, so do not restart bb for this failure.

TODO (open question): the Mac returns an empty catalog with no error. The cause is not known yet. When you see it, record the exact command, its output, and the `models-v2.txt` line count.

Windows: the same commands with `copilot-acp.cmd`. The cache location on Windows was not verified here.

## 4. preToolUse hook fails closed (every tool denied)

Symptom: Copilot denies every tool call. Its log has:

```
Error in preToolUse hook from "agent" (fail-closed): Hook command failed with code 127
```

Code 127 means the hook command could not be found or run (incident 2026-11-09). The agents in `~/src/bb-setup/copilot/agents/orchestrator.agent.md` run `$HOME/.copilot/cantrip/cantrip-agent-guard.sh` and `archgate-stop-gate.mjs`.

```sh
ls ~/.copilot/cantrip/
grep -l 'code 127' ~/.copilot/logs/process-*.log | tail -n 5
```

Expected: `cantrip-agent-guard.sh` and `archgate-stop-gate.mjs` are present. The grep lists every log that ever hit the error, so old logs appear too. Only a log from after the fix with `code 127` means the fix is not in place (`ls -lt ~/.copilot/logs/ | head` shows the newest).

Fix: copy the hook scripts from the ai-agents-setup repo, then start a new Copilot session. Existing sessions keep the old state. Create the destination first, because `~/.copilot/cantrip` may not exist. Name both files explicitly; brace expansion is not available in POSIX `sh`.

```sh
mkdir -p ~/.copilot/cantrip
cp ~/src/ai-agents-setup/copilot/hooks/cantrip-agent-guard.sh ~/src/ai-agents-setup/copilot/hooks/archgate-stop-gate.mjs ~/.copilot/cantrip/
```

Guard self-test. Expected: exit 0 and no output.

```sh
echo '{"toolName":"bash","toolArgs":{"command":"echo ok"}}' | sh ~/.copilot/cantrip/cantrip-agent-guard.sh; echo "exit=$?"
```

End-to-end test. This makes a model call, so run it only when the user wants a live check. Expected: the orchestrator runs `echo ok` and prints `ok`, with no fail-closed error in the newest log.

```sh
cd /tmp && copilot --agent orchestrator -p "run: echo ok" --allow-all-tools
```

Windows: copy `cantrip-agent-guard.ps1` from `ai-agents-setup\copilot\hooks` to `%USERPROFILE%\.copilot\cantrip\`. First check which hook script the Windows agent file calls.

## 5. Model pin unavailable

Symptom: the CLI warns that a pinned model is unavailable and falls back to another model, for example `claude-opus-5.5-medium` falling back to Sonnet.

```sh
grep -h '^model:' ~/.copilot/agents/*.agent.md
```

Each pin must appear in the catalog from check 3. Compare them:

```sh
awk -v id="claude-opus-5.5-medium" 'index($0, id " - ") == 1 {f=1} END {exit !f}' ~/.cache/bb-copilot-acp/models-v2.txt && echo PRESENT || echo MISSING
```

Refresh the catalog first (`copilot-acp --list-models --refresh`), because the cache can be stale.

Fix: change the `model:` line in the agent file in `~/src/bb-setup/copilot/agents/`, to an id from the catalog. Then run `sync.sh -m "<what changed>"`. Start a new Copilot session to pick it up.

Current pins on this machine: `orchestrator`, `planner`, and `reviewer` use `claude-opus-5.5-medium`. `worker` uses `gpt-6.1-terra-medium`. `explorer` uses `claude-haiku-5.5-medium`. `interviewer` uses `gpt-6.1-sol-medium`. All were present in the catalog on 2026-11-09.

## 6. Attachments fail over plain HTTP

Symptom: pasted images or files fail in a thread with `Failed to fetch attachment <name>: Refusing to fetch project attachment over insecure server URL: http://…`. Copilot is not the cause; this affects every provider on the machine. It is listed here because the fix lives with the other machine-side checks.

Cause: the host daemon fetches attachments and self-updates only over `https:` or loopback (`127.0.0.1`, `localhost`, `::1`); see `usesSecureInternalFetchTransport` in `apps/host-daemon/src/server-client.ts`. A daemon on `http://<tailnet-ip>:38886` therefore cannot receive pasted screenshots or files. There is no setting to turn that off.

```sh
grep -h '"serverUrl"' ~/.bb-machines/*/config.json 2>/dev/null
```

Expected after the fix: `"serverUrl": "http://127.0.0.1:<port>"`. A `http://<tailnet-ip>:<port>` value is the failing state.

Fix: run a loopback TCP forwarder on the machine (127.0.0.1:`<port>` to `<server-ip>:<port>`, bytes only), and point the daemon's server URL at the loopback address. This was verified on macOS (2026-11-09): attachments worked afterwards.

Files in `~/src/bb-setup/skills/copilot-troubleshoot/assets/`: `bb-loopback-forward.py` (byte forwarder, placeholders `__SERVER_IP__` and `__PORT__`) and `com.bb-loopback.plist.template` (LaunchAgent, placeholders `__LABEL__`, `__FORWARDER__`, `__LOG__`). Use `~/Library/Application Support/bb-loopback/forward.py` and `~/Library/Logs/bb-loopback.log` unless the machine already has other paths.

Install the forwarder (macOS):

1. Fill in the template: `sed -e 's/__SERVER_IP__/<server-ip>/g' -e 's/__PORT__/<port>/g' ~/src/bb-setup/skills/copilot-troubleshoot/assets/bb-loopback-forward.py > "$HOME/Library/Application Support/bb-loopback/forward.py"` (create the directory first).
2. Write the plist with the label, forwarder and log paths filled in, to `~/Library/LaunchAgents/<label>.plist`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`.
3. Check: `launchctl print gui/$(id -u)/<label>` shows `state = running`, and `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/` returns the same code as `http://<server-ip>:<port>/`.

New Mac: install the forwarder first, then enroll with `http://127.0.0.1:<port>` as the server URL. Untested: the enrollment command comes from the app and was not run against a loopback URL yet. If the installer insists on the public host, enroll as usual and switch afterwards with the steps below. The enrollment steps are in the `onboard-bb-machine` skill.

Switch an enrolled daemon (macOS). Confirm the forwarder answers first; otherwise the daemon loses its connection.

1. Back up `~/.bb-machines/<server-dir>/config.json` and the daemon plist `~/Library/LaunchAgents/app.getbb.host-daemon.<dir-with-dashes>-<hostId>.plist` (the `<dir-with-dashes>` is the data dir name with dots turned into dashes, for example `100-116-88-55-38886`).
2. In `config.json`, set `"serverUrl": "http://127.0.0.1:<port>"`.
3. In the plist, set the argument after `--server-url` (find its index with `plutil -p`; it is `ProgramArguments` item 7 in our file): `/usr/libexec/PlistBuddy -c "Set :ProgramArguments:7 http://127.0.0.1:<port>" <plist>`. The flag takes precedence over `config.json`, so both must change.
4. Restart the daemon from a detached job, never from a bb thread: restarting it kills every bb thread on the machine. Put the restart in a script, for example `launchctl bootout gui/$(id -u)/<daemon-label>; launchctl bootstrap gui/$(id -u) <plist>`, and run it with `launchctl submit -l <job-label> -- /bin/bash <script>`. Remove the job when it has run (`launchctl remove <job-label>`). In our attempt the submitted job re-ran about every 10 seconds until it was removed, so do not leave it submitted.
5. Verify: `logs/host-daemon.1.log` has `Connected to server` with `"serverUrl":"http://127.0.0.1:<port>"`, and a pasted image in a thread loads.

Verify: `launchctl print gui/$(id -u)/<label>` shows `state = running`; the switch checks above pass; a pasted image in a thread loads.

Rollback: stop the daemon the same way, restore the two backed-up files (or set `serverUrl` and the `--server-url` argument back to `http://<server-ip>:<port>`), and bootstrap the daemon again. The tailnet URL keeps chats working; only attachments and self-update fail on it. Unload the forwarder with `launchctl bootout gui/$(id -u)/<label>` when no machine uses it.

Dead ends, so nobody retries them:

- bb Connect is not a practical switch for an enrolled machine. The access provider is stored per machine (`hosts.server_access_provider_id`), a reconnect keeps it, and changing it needs a manual DB edit plus a reinstall.
- The Mac has no out-of-band shell: Tailscale SSH and sshd are off, so a broken switch needs local access.
- Windows: not done yet. The same idea (local forwarder, loopback server URL) should apply, but no Windows steps are verified here.
- `predator` and `IAV-P-STD02-1` probably need the same fix. Not yet checked on either.

## Logs

Copilot process logs are in `~/.copilot/logs/process-*.log`. Newest first: `ls -t ~/.copilot/logs/ | head`.
