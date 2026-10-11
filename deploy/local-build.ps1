# ============================================================
# 开发机（Windows + WSL）：本机构建前端岛与 Linux 二进制 → 上传 → 服务器只装不编译。
#
#   pwsh -File deploy/local-build.ps1              # 前端 + 后端 + 上传 + 部署 dev
#   pwsh -File deploy/local-build.ps1 -SkipFront   # 只重建后端（改 Rust 时）
#
# 为什么：2C2G 的生产机编译会 OOM；WSL 有 16G 内存，构建快且不碰生产。
# ============================================================
param(
  [string]$Distro = 'JMStudio',
  [string]$Server = 'root@191.40.41.97',
  [string]$Key = 'D:\Code\Rust\SC2clud\secrets\ssh\id_ed25519_deploy',
  [switch]$SkipFront
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (-not $SkipFront) {
    Write-Host '==> 构建前端岛（pnpm -C web build）'
    pnpm -C web build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
    Write-Host '==> 上传岛产物到 dev 收件目录'
    ssh -i $Key -o IdentitiesOnly=yes $Server 'install -d -m 0755 /srv/sc2clud-dev/islands-upload'
    scp -i $Key -o IdentitiesOnly=yes -r (Join-Path $root 'crates/sc2clud-web/static/islands/*') ($Server + ':/srv/sc2clud-dev/islands-upload/')
  }
  Write-Host '==> 在 WSL 里构建 Linux 二进制（cargo build --release）'
  $linuxPath = '/mnt/' + $root.Substring(0,1).ToLower() + $root.Substring(2).Replace('\','/')
  wsl.exe -d $Distro -- bash -lc "source `$HOME/.cargo/env && cd '$linuxPath' && cargo build --release -p sc2clud-app"
  if ($LASTEXITCODE -ne 0) { throw 'Rust 构建失败' }
  $bin = Join-Path $root 'target/release/sc2clud'
  if (-not (Test-Path $bin)) { throw "找不到产物 $bin" }
  Write-Host '==> 上传二进制到 dev 收件路径'
  scp -i $Key -o IdentitiesOnly=yes $bin ($Server + ':/srv/sc2clud-dev/sc2clud-upload')
  Write-Host '==> 服务器只装不编译（dev-binary.sh）'
  ssh -i $Key -o IdentitiesOnly=yes $Server 'cd /opt/sc2clud && git fetch --quiet origin main && git reset --hard --quiet origin/main && bash deploy/dev-binary.sh'
  Write-Host '完成：去 http://<域名>/dev/ 验证'
} finally { Pop-Location }
