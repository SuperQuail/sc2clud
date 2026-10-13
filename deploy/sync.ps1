# ============================================================
# SC2clud sync -- refresh dev with a read-only snapshot of production.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 sync
#
#   1. pg_dump -Fc the PRODUCTION database on the box
#   2. stop dev, pg_restore --clean --if-exists into forum_dev, start dev
#
# One direction only. deploy/remote/db-sync.sh refuses to run when the target
# instance is prod, so 'sync prod' is not a mistake this tool can make.
#
# After a sync the accounts carry production password hashes: log in on dev with
# the test account, and never change somebody else's password there (the old
# site's test scripts did exactly that).
#
# NOTE: keep this file ASCII-only (see deploy.ps1).
# ============================================================
[CmdletBinding()]
param(
  [ValidateSet('dev')]
  [string]$Instance = 'dev',
  [string]$SshKey,
  [string]$Server = 'root@191.40.41.97'
)

$ErrorActionPreference = 'Stop'
# A BOM in the piped remote script makes bash report "set: command not found".
$OutputEncoding = New-Object Text.ASCIIEncoding
Set-StrictMode -Version Latest

# The dump belongs to prod and is restored into dev: two different instances, so
# two different lib loads. Keep them in separate scopes.
$srcInstance = 'prod'
. (Join-Path $PSScriptRoot 'lib.ps1')
$prodDir = $InstanceDir
$prodEnv = Get-EnvB64 'prod'

Write-Host ''
Write-Host '== snapshot production database'
$dumpOut = (Invoke-Remote 'backup' @{ SC2CLUD_DIR = $prodDir; SC2CLUD_INSTANCE = 'prod'; SC2CLUD_VERSION = 'sync'; SC2CLUD_ENV_B64 = $prodEnv }).Out
foreach ($line in ($dumpOut -split "`n")) { if ($line.Trim()) { Info $line } }
$dump = ''
foreach ($line in ($dumpOut -split "`n")) {
  if ($line.StartsWith('backup: ')) { $dump = ($line.Substring(8) -split ' ')[0] }
}
if (-not $dump) { Fail 'could not determine the snapshot path from the backup output' }

Write-Host ''
Write-Host '== restore into dev'
$devInstance = 'dev'
$Instance = 'dev'
. (Join-Path $PSScriptRoot 'lib.ps1')
Info ('dump    ' + $dump)
$out = (Invoke-Remote 'db-sync' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = 'dev'; SC2CLUD_DUMP = $dump; SC2CLUD_ENV_B64 = (Get-EnvB64 'dev') }).Out
foreach ($line in ($out -split "`n")) { if ($line.Trim()) { Info $line } }

$r = @{ Code = '000'; Body = '' }
for ($i = 1; $i -le 20; $i++) {
  Start-Sleep -Milliseconds 500
  $r = Invoke-Curl ('http://' + $LocalAddr + '/healthz')
  if ($r.Code -eq '200') { break }
}
Info ('GET /healthz -> ' + $r.Code + ' ' + $r.Body)
if ($r.Code -ne '200') { Fail 'dev did not come back after the restore' }
Write-Host ''
Write-Host '  dev now carries a production snapshot. Log in with the test account.' -ForegroundColor Yellow
Write-Host '  Never change another user password on dev.' -ForegroundColor Yellow
