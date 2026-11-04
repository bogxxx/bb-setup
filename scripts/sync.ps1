<#
Captures the live BB setup into this repo, then commits and pushes.

  .\scripts\sync.ps1                    # commit with a default message
  .\scripts\sync.ps1 -m "Add X plugin"  # your message
  .\scripts\sync.ps1 -NoPush            # capture and commit only
  .\scripts\sync.ps1 -DryRun            # capture only, show git status
#>
param([Alias('m')][string]$Message = 'Sync BB setup', [switch]$NoPush, [switch]$DryRun)

# Windows PowerShell 5.1 and pwsh 7 write different JSON (indentation, escaping), and the
# committed files use the pwsh format. Re-run under pwsh when it exists so the output is stable.
if ($PSVersionTable.PSVersion.Major -lt 7 -and (Get-Command pwsh -ErrorAction SilentlyContinue)) {
  $argv = @('-NoProfile', '-File', $PSCommandPath, '-Message', $Message)
  if ($NoPush) { $argv += '-NoPush' }
  if ($DryRun) { $argv += '-DryRun' }
  & pwsh @argv
  exit $LASTEXITCODE
}

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Write-Host 'Files:'
foreach ($f in $CopiedFiles) { Sync-File $f.Live $f.Repo }

Write-Host 'Links:'
foreach ($d in $LinkedDirs) { Ensure-Junction $d.Live $d.Repo }

Write-Host 'Plugins:'
$plugins = Get-BbPlugins
$repoFull = (Resolve-Path $Repo).Path.TrimEnd('\')
$installed = @(); $builtins = [ordered]@{}
foreach ($p in ($plugins | Sort-Object id)) {
  if ($p.source -like 'builtin:*') { $builtins[$p.id] = [bool]$p.enabled; continue }
  $entry = [ordered]@{ id = $p.id; source = $p.source; enabled = [bool]$p.enabled }
  if ($p.source -like 'path:*') {
    $path = $p.source.Substring(5)
    if ($path.StartsWith($repoFull, [StringComparison]::OrdinalIgnoreCase)) {
      $entry.source = 'repo:' + $path.Substring($repoFull.Length + 1).Replace('\', '/')
    } else {
      # Under 5.1 with 'Stop', redirected stderr from a native command throws.
      $origin = try { git -C $path remote get-url origin 2>$null } catch { $null }
      if ($origin) { $entry.clone = $origin; $entry.path = $path.Replace($HOME, '~') }
      else { Write-Warning "$($p.id) is a local path outside the repo with no git remote: $path" }
    }
  }
  $installed += $entry
}
$manifest = [ordered]@{ installed = $installed; builtinsEnabled = $builtins }
New-Item -ItemType Directory -Force "$Repo\bb" | Out-Null
$manifest | ConvertTo-Json -Depth 5 | Set-Content "$Repo\bb\plugins.json" -Encoding utf8

# Plugin settings: only values that differ from the default, never secret fields.
$settings = [ordered]@{}
foreach ($p in ($plugins | Where-Object { $_.hasSettings } | Sort-Object id)) {
  $cfg = bb plugin config $p.id --json | Out-String | ConvertFrom-Json
  $changed = [ordered]@{}
  foreach ($prop in $cfg.schema.PSObject.Properties) {
    $key = $prop.Name; $schema = $prop.Value
    if ($schema.secret) { continue }
    $value = $cfg.values.$key
    if ($null -eq $value) { continue }
    if ($null -ne $schema.default -and "$value" -eq "$($schema.default)") { continue }
    if ($null -eq $schema.default -and "$value" -eq '') { continue }
    $changed[$key] = $value
  }
  if ($changed.Count) { $settings[$p.id] = $changed }
}
$settings | ConvertTo-Json -Depth 5 | Set-Content "$Repo\bb\plugin-settings.json" -Encoding utf8
Write-Host "  $($installed.Count) installed plugins, $($settings.Count) with custom settings"

# Git writes warnings (CRLF, push hints) to stderr; check exit codes instead of letting
# 5.1 turn stderr into terminating errors.
$ErrorActionPreference = 'Continue'
Push-Location $Repo
try {
  git -c core.safecrlf=false add -A
  if ($LASTEXITCODE) { throw "git add failed ($LASTEXITCODE)" }
  if ($DryRun) { git status --short; return }
  if (-not (git status --porcelain)) {
    Write-Host 'No changes.'
    # Still push commits made outside this script (for example by git am).
    if (-not $NoPush -and (git rev-list --count '@{u}..HEAD' 2>$null) -gt 0) {
      git push -q; if ($LASTEXITCODE) { throw "git push failed ($LASTEXITCODE)" }
      Write-Host 'Pushed.'
    }
    return
  }
  git commit -q -m $Message
  if ($LASTEXITCODE) { throw "git commit failed ($LASTEXITCODE)" }
  Write-Host "Committed: $Message"
  if (-not $NoPush) {
    git push -q; if ($LASTEXITCODE) { throw "git push failed ($LASTEXITCODE)" }
    Write-Host 'Pushed.'
  }
} finally { Pop-Location }
