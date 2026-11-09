---
name: onboard-bb-machine
description: Onboard a new Windows or macOS computer as a bb execution machine for the bogxxx.getbb.app server, with GitHub Copilot and the bb-setup repo, the desktop app pointed at the remote server, and a check that chats work. Also fixes an enrolled machine that bb shows as offline or disconnected while the computer is on (dead host daemon, WMI-blocked restart or autostart). Use when the user asks to add, enroll, connect, set up or onboard a machine or host for bb, pastes a bb enrollment command (X-BB-Enrollment / bbde_ token), or says bb shows their machine offline.
---

# Onboard a new bb machine

The goal is a machine that shows as `connected` in bb, can run GitHub Copilot threads with a working model picker, and has the bb desktop app (if the user wants it) opened on `https://bogxxx.getbb.app`, not on a local server. Work through the steps in order and verify each one. Only the user can do the browser and device sign-ins; ask for them at the step that needs them.

Names used below: `<server>` is `bogxxx.getbb.app`, `<data>` is the machine data dir `~/.bb-machines/<server>` (Windows: `%USERPROFILE%\.bb-machines\bogxxx.getbb.app`).

## 1. Prerequisites

Windows: Node.js LTS, git and gh (`winget install OpenJS.NodeJS.LTS Git.Git GitHub.cli`). macOS: `brew install node git gh`.

## 2. Enroll the machine

Ask the user for a fresh enrollment command (bb app → add machine). Rules:

- The token (`bbde_...`) is single-use. The first run of the install script spends it, even if setup fails later. Never fetch the script to inspect it and then run it again. A spent token returns `This enrollment command has already been used, replaced, or expired`; ask for a new one.
- The app may show the `curl ... install.sh | sh` form. On Windows use the same token with `install.ps1`:

  ```powershell
  irm -Headers @{ 'X-BB-Enrollment' = '<token>' } 'https://<server>/install.ps1' | iex
  ```

- Run it once, synchronously, with a long timeout (it downloads and `npm install`s the bb-app package, about 1 to 4 minutes).

Known failures:

| Message | Fix |
|---|---|
| `Could not exchange machine enrollment credential` | The token is spent. Get a new command. |
| `<data> on this computer belongs to machine host_X, not host_Y` | A failed earlier attempt left `<data>`. Rename it (for example `<data>.failed-host_X`), then rerun with the new token. |
| `Windows refused to create the daemon process through WMI` | Enrollment succeeded (`Machine host_... enrolled`). Only the daemon start failed; see step 3. |

## 3. Start the host daemon (Windows, when WMI is blocked)

Start the same command the installer uses, as a hidden process:

```powershell
$d = "$env:USERPROFILE\.bb-machines\bogxxx.getbb.app"
$hostId = (Get-Content "$d\machine-service.json" -Raw | ConvertFrom-Json).hostId
Start-Process (Get-Command node).Source -WindowStyle Hidden -WorkingDirectory $d -ArgumentList "`"$d\install-machine-windows.mjs`"", '--run', '--host-id', $hostId, '--data-dir', "`"$d`""
```

The installer registers autostart as the HKCU Run value `bb-host-daemon-bogxxx-getbb-app-<hostId>`. That value runs `install-machine-windows.mjs --start`, which goes through WMI again, so at every sign-in it fails silently and the machine stays offline. Rewrite the value to start `--run` directly, and only when the daemon port is not already listening. Back up the old value first:

```powershell
$d = "$env:USERPROFILE\.bb-machines\bogxxx.getbb.app"
$svc = Get-Content "$d\machine-service.json" -Raw | ConvertFrom-Json
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = "bb-host-daemon-bogxxx-getbb-app-$($svc.hostId)"
$node = (Get-Command node).Source   # or the node.exe path in the existing value
(Get-ItemProperty $runKey).$name | Set-Content "$d\run-key.backup.txt"
$inner = "if(-not (Test-NetConnection 127.0.0.1 -Port $($svc.hostDaemonPort) -InformationLevel Quiet -WarningAction SilentlyContinue)){ Start-Process -WindowStyle Hidden -WorkingDirectory '$d' -FilePath '$node' -ArgumentList '`"$d\install-machine-windows.mjs`"','--run','--host-id','$($svc.hostId)','--data-dir','`"$d`"' }"
Set-ItemProperty $runKey -Name $name -Value ('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $inner.Replace('"','\"') + '"')
```

Test it while the daemon runs: `cmd /c (Get-ItemProperty $runKey).$name` must not start a second `bb-app.js host-daemon` process. A bb update or a reinstall may restore the WMI version of the value. Check it again after one.

To restart the daemon (needed after PATH changes), stop the node processes whose command line matches `bb-machines|install-machine-windows|bb-host-daemon`, by PID, then start it again:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bb-machines|install-machine-windows|bb-host-daemon' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Before starting it again, reload PATH in the same shell (`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`), so the daemon inherits the new entries.

Verify:

- `(Invoke-WebRequest http://127.0.0.1:38888/status -UseBasicParsing).Content` returns this machine's `hostId` with `"connected":true`. This is the quickest check, and it needs no bb login.
- The newest `<data>\logs\host-daemon.N.log` contains `Connected to server` and `Host daemon started`.
- The daemon port (`<data>\host-daemon-port`, usually 38888) is listening.
- In the bb web app (signed in), `fetch('/api/v1/hosts')` lists the machine's host id with `"status":"connected"`.

The `bb` CLI under `<data>\npm\bb.cmd` returns `HTTP 401` on a machine that is only enrolled. The machine credential is not a user session. Verify through the app instead.

`provider.list_models` errors in the daemon log for agents that are not installed (Codex, Claude Code, cursor-agent, agy, `copilot-acp-sopra`) are expected. They only matter for agents this machine should run. Do not try to fix them, or disable those providers, as part of a connection problem.

### Machine shows offline while the computer is on

Threads are stored on the server, so they still look live in the app when this machine's daemon is down. Diagnose in this order (incident 2026-11-09):

1. `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` and look for `bb-app.js host-daemon` and `daemon-bundle.mjs`. If neither is there, the daemon and its supervisor are both dead. Before it died, the log showed a loop of `Disconnected from server` / `fetch failed`, then nothing more.
2. Check that the server is reachable: `Invoke-WebRequest https://bogxxx.getbb.app` returning `401` is fine. A network error means a VPN or proxy problem, not a bb problem.
3. `node "<data>\install-machine-windows.mjs" --start --host-id <hostId>` fails with `Windows refused to create the daemon process through WMI`. Confirm the block with `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c exit 0' }`. `ReturnValue 2` means access denied, most likely a security policy that blocks process creation through WMI.
4. Start the daemon with the `Start-Process ... --run` command above. Fix the Run value as well, then verify `/status` returns `"connected":true`.

`bb machine list` from this machine returns `HTTP 401` or `Cannot connect to BB server`. That does not mean the machine is offline. Use `/status` and the logs instead.

## 4. GitHub Copilot CLI and sign-in

On Windows install it with winget, not npm. The bb-setup launcher looks for `copilot.exe` on PATH and in `%LOCALAPPDATA%\GitHubCopilotCLI`, which is where winget puts it. npm only provides `copilot.cmd`, which it does not find (set `COPILOT_BIN` if it has to stay that way). An npm install that is already there can stay; it does not get in the way.

```powershell
winget install GitHub.Copilot
copilot login            # device flow: the user approves the code in the browser
```

The launcher gives Copilot the token of the gh account `bohdan-krechko-akerbp` (`COPILOT_GH_USER`), so make sure `gh auth status` lists that account too (`gh auth login`). Never run `gh auth switch`, because bb's Copilot integration depends on the active gh account.

## 5. bb-setup: Copilot launcher, skills and agent files

bb's `provider-acp.customAgents` setting runs the bare command `copilot-acp`. It is called with `--list-models` for the model picker and with `--model <id>` to start a thread. That command comes from this repo:

```powershell
git clone https://github.com/bogxxx/bb-setup $HOME\src\bb-setup
& $HOME\src\bb-setup\scripts\install.ps1 -SkipPlugins -SkipSettings
```

- The repo is public, so cloning needs no login.
- `-SkipPlugins -SkipSettings`: plugins and plugin settings live on the bb server, which already has them. They also need an authenticated `bb` CLI, which an enrolled-only machine does not have (step 3).
- `install.ps1` links `skills/*` into `~/.bb/skills` and `claude/agents` into `~/.claude/agents`. It copies `bb/AGENTS.md`, the Copilot and Cursor agent files, and `bb/bin/copilot-acp.cmd` to `%USERPROFILE%\.local\bin`.
- Copies go newer-wins, and a fresh clone is newer than anything already on the machine. Existing `~/.copilot/agents`, `~/.cursor/agents`, `~/.claude/CLAUDE.md` and `~/.bb/AGENTS.md` are overwritten with the repo versions. Back them up first (for example `Copy-Item ~\.copilot\agents ~\.copilot\agents.bak-<timestamp> -Recurse`) and tell the user where the backup is.
- Put `%USERPROFILE%\.local\bin` at the front of the user PATH if it is missing: `[Environment]::SetEnvironmentVariable('Path', "$env:USERPROFILE\.local\bin;$([Environment]::GetEnvironmentVariable('Path','User'))", 'User')`. Then restart the daemon (step 3).
- Remove any hand-made `copilot-acp.cmd` or `copilot-acp` wrapper elsewhere on PATH (for example next to `node.exe` or `copilot.cmd`), so it cannot shadow the repo launcher. `(Get-Command copilot-acp).Source` must be `%USERPROFILE%\.local\bin\copilot-acp.cmd`.
- macOS: clone to `~/src/bb-setup` and run `scripts/sync.sh --no-plugins --no-push`. It symlinks `~/.local/bin/copilot-acp` and the rest.

Verify in a new shell:

```powershell
copilot-acp --list-models     # about 180 "id - Name" lines; the first probe takes about 20 s, then it is cached for a day
copilot-acp --print-args --model claude-opus-5.5-high
# ["--acp","--model","claude-opus-5.5","--reasoning-effort","high","--context","long_context"]
```

The list must include the context tier and effort variants, such as `claude-opus-5.5-high` and `claude-opus-5.5-standard-high`. A short plain list (`claude-opus-5.5 - Claude Opus 5.5`) means another `copilot-acp` is earlier on PATH.

"GitHub Copilot (SopraSteria)" (`copilot-acp-sopra`) has only a macOS shim. On Windows it stays "CLI not found" unless that account is set up separately. That is expected.

## 6. Desktop app (optional)

Windows build: `gh release download -R get-bb/bb --pattern 'bb-*-x64.exe' -D $env:TEMP` (latest `desktop-v*` release), then run it with `/S` for a silent per-user install into `%LOCALAPPDATA%\Programs\bb`.

On first start the app runs its own built-in local server (`127.0.0.1:38886`) and shows "Connect a coding agent" onboarding. That is the "local server" to replace with `<server>`:

1. Prefer the UI. Go to Choose server…, sign in to bb Connect with the account that owns `<server>`, and select it.
2. If you write `%APPDATA%\bb\server-target.json` yourself, write UTF-8 without a BOM. Windows PowerShell's `Set-Content -Encoding UTF8` adds a BOM, the app cannot parse the file, and it silently falls back to the built-in server. Use `[IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding $false))` with `{"connectServer":{"handle":"bogxxx","name":"bogxxx","url":"https://bogxxx.getbb.app"},"customServerUrl":null,"customServerUrls":[],"target":"connect"}`, then restart the app.
3. If the window shows "Could not authenticate with bb Connect" (HTTP 500/503), the app has no account session yet. The user signs in through Choose server….

The desktop log is `~/.bb/logs/desktop.log`.

## 7. Final check

In the bb app (web or desktop), start a new thread and select this machine and **GitHub Copilot**. The composer may default to "GitHub Copilot (SopraSteria)", so pick the plain "GitHub Copilot" icon in the picker. Its models should show context sizes, for example "Claude Sonnet 5.5 936k" and "Claude Sonnet 5.5 200k", or "Claude Opus 5.5 1M". That confirms the repo launcher is in use. "Could not load models … failed to provide a model catalog" means `copilot-acp --list-models` fails on the machine (go back to steps 4 and 5). Confirm the user's projects and chats are listed. Report what was done, what was verified, and anything left (daemon autostart, agents not installed, sign-ins still needed).
