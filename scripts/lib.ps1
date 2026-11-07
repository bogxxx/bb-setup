# Shared helpers for sync.ps1 and install.ps1. Windows PowerShell 5.1 compatible.

$Repo = Split-Path -Parent $PSScriptRoot
$BbDir = Join-Path $HOME '.bb'
$ClaudeDir = Join-Path $HOME '.claude'

# Folders that bb / Claude read live from this repo through junctions.
# Edit them in the repo (or through the live path, which is the same folder).
$LinkedDirs = @(
  @{ Live = "$ClaudeDir\agents";                    Repo = "$Repo\claude\agents" }
)
# Every skill folder in the repo is linked, so new skills reach every machine.
if (Test-Path "$Repo\skills") {
  foreach ($d in Get-ChildItem "$Repo\skills" -Directory) {
    if (Test-Path "$($d.FullName)\SKILL.md") {
      $LinkedDirs += @{ Live = "$BbDir\skills\$($d.Name)"; Repo = $d.FullName }
    }
  }
}

# Single files cannot be linked without admin rights, so they are copied.
# The newer copy wins in both directions.
$CopiedFiles = @(
  @{ Live = "$BbDir\AGENTS.md";            Repo = "$Repo\bb\AGENTS.md" },
  @{ Live = "$HOME\.local\bin\copilot-acp.cmd"; Repo = "$Repo\bb\bin\copilot-acp.cmd" },
  @{ Live = "$ClaudeDir\CLAUDE.md";        Repo = "$Repo\claude\CLAUDE.md" },
  @{ Live = "$HOME\.copilot\agents\orchestrator.agent.md"; Repo = "$Repo\copilot\agents\orchestrator.agent.md" },
  @{ Live = "$HOME\.copilot\agents\explorer.agent.md";     Repo = "$Repo\copilot\agents\explorer.agent.md" },
  @{ Live = "$HOME\.copilot\agents\planner.agent.md";      Repo = "$Repo\copilot\agents\planner.agent.md" },
  @{ Live = "$HOME\.copilot\agents\worker.agent.md";       Repo = "$Repo\copilot\agents\worker.agent.md" },
  @{ Live = "$HOME\.copilot\agents\reviewer.agent.md";     Repo = "$Repo\copilot\agents\reviewer.agent.md" },
  @{ Live = "$HOME\.copilot\agents\interviewer.agent.md";   Repo = "$Repo\copilot\agents\interviewer.agent.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-goal.md";        Repo = "$Repo\cursor\agents\cantrip-goal.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-explore.md";     Repo = "$Repo\cursor\agents\cantrip-explore.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-plan.md";        Repo = "$Repo\cursor\agents\cantrip-plan.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-implement.md";   Repo = "$Repo\cursor\agents\cantrip-implement.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-review.md";      Repo = "$Repo\cursor\agents\cantrip-review.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-interview.md";   Repo = "$Repo\cursor\agents\cantrip-interview.md" }
)

function Sync-File($live, $repo) {
  $hasLive = Test-Path $live; $hasRepo = Test-Path $repo
  if (-not $hasLive -and -not $hasRepo) { return }
  if ($hasLive -and $hasRepo) {
    if ((Get-FileHash $live).Hash -eq (Get-FileHash $repo).Hash) { return }
    $liveNewer = (Get-Item $live).LastWriteTimeUtc -gt (Get-Item $repo).LastWriteTimeUtc
  } else { $liveNewer = $hasLive }
  if ($liveNewer) { $from = $live; $to = $repo } else { $from = $repo; $to = $live }
  New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
  Copy-Item $from $to -Force
  Write-Host "  copied $from -> $to"
}

function Ensure-Junction($live, $repo) {
  $item = Get-Item $live -ErrorAction SilentlyContinue
  if ($item -and $item.LinkType -eq 'Junction') { return }
  if ($item) {
    $bak = "$live.bak-$(Get-Date -Format yyyyMMddHHmmss)"
    Move-Item $live $bak
    Write-Host "  moved existing $live to $bak"
  }
  New-Item -ItemType Directory -Force (Split-Path -Parent $live) | Out-Null
  New-Item -ItemType Junction -Path $live -Target $repo | Out-Null
  Write-Host "  linked $live -> $repo"
}

# bb runs from $env:BB_CLI when it is set (a .js entry point runs under node), else bb on PATH.
# bb on PATH can fail silently in agent sandboxes, so sync.ps1 and install.ps1 use this.
function Invoke-Bb {
  $cli = $env:BB_CLI
  if ($cli -and (Test-Path -LiteralPath $cli -PathType Leaf)) {
    if ([IO.Path]::GetExtension($cli) -in '', '.js', '.mjs', '.cjs') { & node $cli @args } else { & $cli @args }
  } else { & bb @args }
}

# A bb query that fails closed: a non-zero exit or empty output throws, so nothing is written.
function Get-BbText($What, [string[]]$Argv) {
  $text = Invoke-Bb @Argv | Out-String
  if ($LASTEXITCODE) { throw "$What failed ($LASTEXITCODE); nothing written" }
  if (-not $text.Trim()) { throw "$What printed nothing; nothing written" }
  $text
}

function Get-BbJson($What, [string[]]$Argv) {
  $text = Get-BbText $What $Argv
  try { $text | ConvertFrom-Json } catch { throw "$What printed invalid JSON; nothing written" }
}

# The data dir of the bb server the CLI is connected to.
function Get-BbDataDir {
  $status = Get-BbText 'bb status' @('status')
  if ($status -match '(?m)^Data dir:\s*(.+?)\s*$') { return $Matches[1] }
  throw 'bb status shows no Data dir; nothing written'
}

function Get-BbPlugins {
  $plugins = (Get-BbJson 'bb plugin list' @('plugin', 'list', '--json')).plugins
  if (-not $plugins) { throw 'bb plugin list returned no plugins; nothing written' }
  @($plugins)
}
