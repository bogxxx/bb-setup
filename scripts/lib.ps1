# Shared helpers for sync.ps1 and install.ps1. Windows PowerShell 5.1 compatible.

$Repo = Split-Path -Parent $PSScriptRoot
$BbDir = Join-Path $HOME '.bb'
$ClaudeDir = Join-Path $HOME '.claude'

# Folders that bb / Claude read live from this repo through junctions.
# Edit them in the repo (or through the live path, which is the same folder).
$LinkedDirs = @(
  @{ Live = "$BbDir\skills\provider-orchestration"; Repo = "$Repo\skills\provider-orchestration" },
  @{ Live = "$ClaudeDir\agents";                    Repo = "$Repo\claude\agents" }
)

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
  @{ Live = "$HOME\.cursor\agents\cantrip-goal.md";        Repo = "$Repo\cursor\agents\cantrip-goal.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-explore.md";     Repo = "$Repo\cursor\agents\cantrip-explore.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-plan.md";        Repo = "$Repo\cursor\agents\cantrip-plan.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-implement.md";   Repo = "$Repo\cursor\agents\cantrip-implement.md" },
  @{ Live = "$HOME\.cursor\agents\cantrip-review.md";      Repo = "$Repo\cursor\agents\cantrip-review.md" }
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

function Get-BbPlugins { (bb plugin list --json | Out-String | ConvertFrom-Json).plugins }
