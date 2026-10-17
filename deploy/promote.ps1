# ============================================================
# SC2clud promote -- put the version ALREADY VERIFIED ON DEV onto prod.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/promote.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/promote.ps1 -Version <v>
#
# The gate is mechanical, not a promise: if dev is not running -Version, this
# script refuses. 'Tested on dev' becomes a fact the machine checked.
#
# It builds nothing itself: it calls deploy.ps1 for prod with -SkipBuild, so what
# prod gets is the same commit and the same web/dist that dev ran.
#
# NOTE: keep this file ASCII-only (see deploy.ps1).
# ============================================================
[CmdletBinding()]
param(
  [string]$Version,
  [string]$SshKey,
  [string]$Server = 'root@191.40.41.97',
  [switch]$SkipDbBackup
)

$ErrorActionPreference = 'Stop'
# A BOM in the piped remote script makes bash report "set: command not found".
$OutputEncoding = New-Object Text.ASCIIEncoding
Set-StrictMode -Version Latest

# --- what is dev running right now? -----------------------------------------
$Instance = 'dev'
. (Join-Path $PSScriptRoot 'lib.ps1')
$devAddr = $LocalAddr
$devHealth = Invoke-Remote 'health' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = 'dev'; SC2CLUD_ENV_B64 = (Get-EnvB64 'dev') } -AllowFail
$devFacts = ConvertFrom-Facts $devHealth.Out
$devRunning = ''
if ($devFacts['health_body']) {
  try { $devRunning = ([string](($devFacts['health_body'] | ConvertFrom-Json).version)) } catch { $devRunning = '' }
}

$shown = $devRunning
if (-not $shown) { $shown = '(unreachable)' }
Write-Host ''
Write-Host ('dev  ' + $devAddr + '  running=' + $shown + '  on-disk=' + $devFacts['version'])

if (-not $Version) { $Version = $devRunning }
if (-not $Version) {
  Fail 'dev is not answering, so there is no verified version to promote. Pass -Version to override, and say why in the report.'
}
if ($devRunning -and $Version -ne $devRunning) {
  Fail ('refusing to promote ' + $Version + ': dev is running ' + $devRunning + '. Promote only what dev has actually run.')
}
if (-not $devRunning) {
  Warn ('dev did not answer /healthz; promoting ' + $Version + ' anyway because -Version was given explicitly')
}
Write-Host ('promote -> prod : ' + $Version) -ForegroundColor Green

$deployArgs = @{
  Instance = 'prod'
  Version  = $Version
  SshKey   = $SshKey
  Server   = $Server
  SkipBuild = $true
}
if ($SkipDbBackup) { $deployArgs['SkipDbBackup'] = $true }
& (Join-Path $PSScriptRoot 'deploy.ps1') @deployArgs
exit $LASTEXITCODE
