# 前端岛产物在 .gitignore 里（服务器没有 Node，不能在那边构建），
# 所以每次发布都要在本机构建后同步过去。
# 用法：pwsh -File scripts/push-islands.ps1
param([string]$Server = 'root@191.40.41.97', [string]$Key = '..\..\secrets\ssh\id_ed25519_deploy')

$ErrorActionPreference = 'Continue'
$site = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $site
try {
  Write-Host '构建前端岛…'
  & pnpm -C web build 2>&1 | Select-Object -Last 2
  $dir = Join-Path $site 'crates\sc2clud-web\static\islands'
  if (-not (Test-Path $dir)) { throw "没有产物目录：$dir" }
  & ssh -i $Key -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 $Server 'mkdir -p /opt/sc2clud/crates/sc2clud-web/static/islands'
  Get-ChildItem $dir -File | ForEach-Object {
    & scp -i $Key -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 $_.FullName "${Server}:/opt/sc2clud/crates/sc2clud-web/static/islands/" | Out-Null
    Write-Host ("  ok  {0} ({1} KB)" -f $_.Name, [math]::Round($_.Length / 1KB, 1))
  }
} finally { Pop-Location }
