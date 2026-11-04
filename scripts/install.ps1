<#
Applies this repo to a machine: links folders, copies files, builds and installs
plugins, matches builtin plugin on/off state, and applies plugin settings.
Safe to run again. Needs bb running, plus git, node and npm.

  git clone https://github.com/bogxxx/bb-setup $HOME\src\bb-setup
  & $HOME\src\bb-setup\scripts\install.ps1
#>
param([switch]$SkipPlugins, [switch]$SkipSettings)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Write-Host 'Links:'
foreach ($d in $LinkedDirs) { Ensure-Junction $d.Live $d.Repo }

Write-Host 'Files:'
foreach ($f in $CopiedFiles) { Sync-File $f.Live $f.Repo }

$manifest = Get-Content "$Repo\bb\plugins.json" -Raw | ConvertFrom-Json

if (-not $SkipPlugins) {
  Write-Host 'Plugins:'
  $current = @{}; foreach ($p in Get-BbPlugins) { $current[$p.id] = $p }
  foreach ($e in $manifest.installed) {
    if ($e.source -like 'repo:*') {
      $dir = Join-Path $Repo $e.source.Substring(5)
      Push-Location $dir
      try { npm ci --no-audit --no-fund; bb plugin build } finally { Pop-Location }
      if (-not $current[$e.id] -or $current[$e.id].source -ne "path:$dir") { bb plugin install $dir --yes }
      else { bb plugin reload $e.id }
    } elseif ($e.clone) {
      $dir = $e.path -replace '^~', $HOME
      if (-not (Test-Path $dir)) { git clone $e.clone $dir }
      if (-not $current[$e.id]) { bb plugin install $dir --yes }
    } elseif (-not $current[$e.id]) {
      if ($e.subdirectory) { bb plugin install $e.source --subdirectory $e.subdirectory --yes }
      else { bb plugin install $e.source --yes }
    }
    if (-not $e.enabled) { bb plugin disable $e.id | Out-Null }
  }
  foreach ($prop in $manifest.builtinsEnabled.PSObject.Properties) {
    $p = $current[$prop.Name]
    if (-not $p -or [bool]$p.enabled -eq [bool]$prop.Value) { continue }
    if ($prop.Value) { bb plugin enable $prop.Name | Out-Null } else { bb plugin disable $prop.Name | Out-Null }
    Write-Host "  $($prop.Name) enabled=$($prop.Value)"
  }
}

if (-not $SkipSettings) {
  Write-Host 'Settings:'
  $settings = Get-Content "$Repo\bb\plugin-settings.json" -Raw | ConvertFrom-Json
  foreach ($plugin in $settings.PSObject.Properties) {
    foreach ($kv in $plugin.Value.PSObject.Properties) {
      $value = $kv.Value
      if ($value -is [bool]) { $value = "$value".ToLower() }
      # Windows PowerShell drops embedded quotes when calling native programs.
      if ($PSVersionTable.PSVersion -lt [version]'7.3') { $value = "$value" -replace '"', '\"' }
      bb plugin config $plugin.Name set $kv.Name "$value" | Out-Null
      Write-Host "  $($plugin.Name).$($kv.Name)"
    }
  }
}
Write-Host 'Done. Secrets (plugin secrets, account logins, gh auth) are not in this repo; set them by hand.'
