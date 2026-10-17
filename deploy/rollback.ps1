# ============================================================
# SC2clud rollback -- point an instance back at a previous release.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/rollback.ps1 -Instance prod
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/rollback.ps1 -Instance prod -Target <v>
#
# Without -Target the previous release is chosen (the newest one that is not
# current). With no previous release the script refuses instead of guessing.
#
# The database is NOT rolled back. Migrations are forward-only here; if a
# rollback really has to undo schema, that is the pre-deploy dump under
# <instance>/backups/ and a human decision.
#
# NOTE: keep this file ASCII-only (see deploy.ps1).
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'prod')]
  [string]$Instance,
  [string]$Target,
  [string]$SshKey,
  [string]$Server = 'root@191.40.41.97'
)

$ErrorActionPreference = 'Stop'
# A BOM in the piped remote script makes bash report "set: command not found".
$OutputEncoding = New-Object Text.ASCIIEncoding
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib.ps1')

$envB64 = Get-EnvB64 $Instance
$current = Get-RemoteLink ($InstanceDir + '/current') $Instance
$currentShown = $current
if (-not $currentShown) { $currentShown = '(none)' }
Info ('current -> ' + $currentShown)

if (-not $Target) {
  $list = (Invoke-RemoteRaw ("ls -1dt '" + $InstanceDir + "'/releases/*/ 2>/dev/null || true")).Out
  foreach ($line in ($list -split "`n")) {
    $t = $line.Trim()
    if (-not $t) { continue }
    $name = $t.TrimEnd('/').Split('/')[-1]
    if (('releases/' + $name) -ne $current) { $Target = $name; break }
  }
  if (-not $Target) { Fail 'no previous release to roll back to' }
  Info ('target  -> ' + $Target + ' (newest release that is not current)')
}
else {
  Info ('target  -> ' + $Target + ' (given)')
}

$out = (Invoke-Remote 'rollback' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_TARGET = $Target; SC2CLUD_ENV_B64 = $envB64 }).Out
foreach ($line in ($out -split "`n")) { if ($line.Trim()) { Info $line } }

$r = @{ Code = '000'; Body = '' }
for ($i = 1; $i -le 20; $i++) {
  Start-Sleep -Milliseconds 500
  $r = Invoke-Curl ('http://' + $LocalAddr + '/healthz')
  if ($r.Code -eq '200') { break }
}
Info ('GET /healthz -> ' + $r.Code + ' ' + $r.Body)
if ($r.Code -ne '200') { Fail ('the instance did not come back up after rollback (systemctl status ' + $UnitName + ')') }
Write-Host ''
Write-Host ('  ROLLED BACK to ' + $Target) -ForegroundColor Yellow
Write-Host '  The DATABASE was not rolled back: migrations are forward-only here.' -ForegroundColor Yellow
