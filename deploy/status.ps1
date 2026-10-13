# ============================================================
# SC2clud status -- what is actually running on the server.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/status.ps1
#
# Prints FACTS, not verdicts: release on disk, version the process reports, home
# page code, schema version, disk. If a number looks wrong, the number is the
# evidence -- there is no 'OK' here that a human has to trust.
#
# NOTE: keep this file ASCII-only (see deploy.ps1).
# ============================================================
[CmdletBinding()]
param(
  [string]$SshKey,
  [string]$Server = 'root@191.40.41.97',
  [ValidateSet('dev', 'prod', 'both')]
  [string]$Instance = 'both'
)

$ErrorActionPreference = 'Stop'
# A BOM in the piped remote script makes bash report "set: command not found".
$OutputEncoding = New-Object Text.ASCIIEncoding
Set-StrictMode -Version Latest

$instances = @('dev', 'prod')
if ($Instance -ne 'both') { $instances = @($Instance) }

foreach ($inst in $instances) {
  $Instance = $inst
  . (Join-Path $PSScriptRoot 'lib.ps1')

  Write-Host ''
  Write-Host ('== ' + $inst + '  ' + $InstanceDir + '  ' + $LocalAddr)

  $envB64 = Get-EnvB64 $inst
  if ($envB64 -eq (B64 '__MISSING__')) {
    Warn ('/etc/sc2clud/' + $inst + '.env is missing -- this instance is not installed yet')
  }

  $link = Get-RemoteLink ($InstanceDir + '/current') $inst
  if ($link) { Info ('current -> ' + $link) } else { Info 'current -> (none)' }

  $releases = (Invoke-RemoteRaw ("ls -1dt '" + $InstanceDir + "'/releases/*/ 2>/dev/null | head -5 || true")).Out
  foreach ($line in ($releases -split "`n")) { if ($line.Trim()) { Info ('release  ' + $line.Trim()) } }

  if ($envB64 -ne (B64 '__MISSING__')) {
    $res = Invoke-Remote 'health' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $inst; SC2CLUD_ENV_B64 = $envB64 } -AllowFail
    $facts = ConvertFrom-Facts $res.Out
    Info ('unit     ' + $facts['unit'] + '   addr ' + $facts['addr'])
    Info ('on disk  VERSION=' + $facts['version'] + '  web/dist/VERSION=' + $facts['web_version'])
    Info ('health   ' + $facts['health_code'] + '  ' + $facts['health_body'])
    Info ('home     ' + $facts['home_code'] + '  ' + $facts['home_bytes'] + ' bytes  asset=' + $facts['asset'] + ' (' + $facts['asset_code'] + ')')
    Info ('schema   ' + $facts['schema_migrations'])
    Info ('disk     ' + $facts['disk_free_mb'] + ' MB free under ' + $InstanceDir)
  }

  $pub = Invoke-Curl $PublicUrl
  Info ('public   ' + $PublicUrl + ' -> ' + $pub.Code + ' (through nginx)')
}
Write-Host ''
