# 在开发者机器上：构建前端岛并上传到 dev 的收件目录（不碰生产）
#   pwsh -File deploy/islands-push.ps1
param(
  [string]$Server = 'root@191.40.41.97',
  [string]$Key = 'D:\Code\Rust\SC2clud\secrets\ssh\id_ed25519_deploy'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host '==> 构建前端岛（pnpm -C web build）'
  pnpm -C web build
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
  $src = Join-Path $root 'crates/sc2clud-web/static/islands'
  Write-Host '==> 上传到 /srv/sc2clud-dev/islands-upload（dev 收件目录，不碰生产）'
  ssh -i $Key -o IdentitiesOnly=yes $Server 'install -d -m 0755 /srv/sc2clud-dev/islands-upload'
  scp -i $Key -o IdentitiesOnly=yes -r (Join-Path $src '*') ($Server + ':/srv/sc2clud-dev/islands-upload/')
  Write-Host '==> 完成：接着跑 bash deploy/dev.sh（在服务器上）'
} finally { Pop-Location }
