<#
Captures the live BB setup into this repo, then commits and pushes.

  .\scripts\sync.ps1                    # commit with a default message
  .\scripts\sync.ps1 -m "Add X plugin"  # your message
  .\scripts\sync.ps1 -NoPush            # capture and commit only
  .\scripts\sync.ps1 -DryRun            # capture only, show git status
#>
param([Alias('m')][string]$Message = 'Sync BB setup', [switch]$NoPush, [switch]$DryRun)
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
      $origin = git -C $path remote get-url origin 2>$null
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

Push-Location $Repo
try {
  git -c core.safecrlf=false add -A
  if ($DryRun) { git status --short; return }
  if (-not (git status --porcelain)) { Write-Host 'No changes.'; return }
  git commit -q -m $Message
  Write-Host "Committed: $Message"
  if (-not $NoPush) { git push -q; Write-Host 'Pushed.' }
} finally { Pop-Location }
