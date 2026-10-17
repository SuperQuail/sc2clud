# ============================================================
# SC2clud rollback drill -- prove the rollback path really goes back.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/drill-rollback.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/drill-rollback.ps1 -Instance prod
#
# It aims the health check at a path that cannot return 200, deploys the SAME
# code under a new release name, and then checks three things:
#
#   1. deploy.ps1 exits 3 (failed, rolled back)
#   2. current points at the release that was live before the drill
#   3. /healthz answers 200 again, reporting the previous version
#
# A rollback nobody has ever executed is a story, not a mechanism. Run this
# after any change to deploy.ps1 or the remote scripts.
#
# NOTE: keep this file ASCII-only (see deploy.ps1).
# ============================================================
[CmdletBinding()]
param(
  [ValidateSet('dev', 'prod')]
  [string]$Instance = 'dev',
  [string]$Version,
  [string]$SshKey,
  [string]$Server = 'root@191.40.41.97',
  [switch]$SkipDbBackup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$drillVersion = $Version
if (-not $drillVersion) { $drillVersion = 'rollback-drill-' + (Get-Date -Format yyyyMMdd-HHmmss) }

# Read the state we expect to come back to.
$probe = 'dev'
. (Join-Path $PSScriptRoot 'lib.ps1')
$targetDir = $InstanceDir
$targetAddr = $LocalAddr
$targetEnv = Get-EnvB64 $Instance
$before = (Invoke-Remote 'health' @{ SC2CLUD_DIR = $targetDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_ENV_B64 = $targetEnv } -AllowFail).Out
$beforeFacts = ConvertFrom-Facts $before
$beforeVersion = $beforeFacts['health_body']
try { $beforeVersion = [string](($beforeFacts['health_body'] | ConvertFrom-Json).version) } catch { }
if (-not $beforeVersion) { Fail ('the instance is not healthy before the drill, so the drill proves nothing: ' + $before) }

Write-Host ''
Write-Host ('drill on ' + $Instance + ': live version is ' + $beforeVersion) -ForegroundColor Cyan
Write-Host ('aiming /healthz at /__no_such_path__ and deploying ' + $drillVersion)

$deployArgs = @{
  Instance   = $Instance
  Version    = $drillVersion
  HealthPath = '/__no_such_path__'
  SshKey     = $SshKey
  Server     = $Server
  SkipBuild  = $true
}
if ($SkipDbBackup) { $deployArgs['SkipDbBackup'] = $true }
& (Join-Path $PSScriptRoot 'deploy.ps1') @deployArgs
$code = $LASTEXITCODE

Write-Host ''
Write-Host '---- drill verdict ----'
if ($code -ne 3) { Fail ('expected deploy.ps1 to fail AND roll back (exit 3), got exit ' + $code + '. Either the health check did not fail, or the rollback did not run.') }

$link = Get-RemoteLink ($targetDir + '/current') $Instance
Write-Host ('current -> ' + $link)
if ($link -eq ('releases/' + $drillVersion)) { Fail 'the failed release is still current -- the rollback did not switch back' }

$after = (Invoke-Remote 'health' @{ SC2CLUD_DIR = $targetDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_ENV_B64 = $targetEnv } -AllowFail).Out
$afterFacts = ConvertFrom-Facts $after
$afterVersion = ''
try { $afterVersion = [string](($afterFacts['health_body'] | ConvertFrom-Json).version) } catch { }
Write-Host ('after  -> ' + $afterFacts['health_code'] + ' ' + $afterFacts['health_body'])

if ($afterFacts['health_code'] -ne '200') { Fail ('the instance is not healthy after the rollback: HTTP ' + $afterFacts['health_code']) }
if ($afterVersion -ne $beforeVersion) { Fail ('after the rollback /healthz reports ' + $afterVersion + ', expected ' + $beforeVersion) }

Write-Host ''
Write-Host '  DRILL PASSED: failure -> rollback -> previous version live again' -ForegroundColor Green
Write-Host ('  failed release kept on disk (on purpose): ' + $drillVersion)
exit 0
