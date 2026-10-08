# ============================================================
# 截图工具：本地起一个临时实例，把关键页面渲染成 PNG
#
# 为什么不用 agent-browser：本机环境里它对公网 IP 报 ERR_BLOCKED_BY_CLIENT，
# 对 localhost 直接挂死；系统自带的 Chromium（Edge/Chrome）headless 截图稳定可用。
#
# 用法：pwsh -File scripts/shot.ps1 [ -OutDir <目录> ]
# 默认输出到仓库外层工作区的 shots/（截图不进版本库）。
# ============================================================

param(
  [int]$Port = 18110,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\shots'),
  [string]$Password = 'shot-pass'
)

$ErrorActionPreference = 'Continue'
$exe = Join-Path $PSScriptRoot '..\target\debug\sc2clud.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $PSScriptRoot '..\target\debug\sc2clud' }
if (-not (Test-Path $exe)) { Write-Host '先 cargo build -p sc2clud-app' -ForegroundColor Red; exit 2 }

$browser = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Write-Host '找不到 Chrome/Edge' -ForegroundColor Red; exit 2 }

# askama 模板在编译期内嵌进二进制：改了模板必须重建，否则截到的是旧页面。
Write-Host '构建（保证模板改动生效）…'
Push-Location (Join-Path $PSScriptRoot '..')
& cargo build -p sc2clud-app -q 2>&1 | Select-Object -Last 3
Pop-Location

New-Item -ItemType Directory -Force $OutDir | Out-Null
$work = Join-Path $env:TEMP ('sc2clud-shot-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$base = "http://127.0.0.1:$Port"
$jar = Join-Path $work 'c.txt'

$env:SC2CLUD_DATA_DIR = $work
$env:SC2CLUD_DOWNLOAD_SECRET = 'shot-secret'
$env:SC2CLUD_BIND = "127.0.0.1:$Port"
$env:SC2CLUD_BASE_URL = $base
$env:SC2CLUD_LOG = 'warn'
# 本地截图必须让应用自己回图片字节（生产由 nginx 直出；该开关在非回环监听时会被配置校验拒绝）。
$env:SC2CLUD_SERVE_BLOBS_LOCALLY = '1'
$proc = Start-Process -FilePath $exe -ArgumentList 'serve' -PassThru -NoNewWindow -RedirectStandardOutput "$work\o.log" -RedirectStandardError "$work\e.log"

function Snap([string]$path, [string]$name, [int]$height = 1500) {
  $out = Join-Path $OutDir "$name.png"
  $profile = Join-Path $work "profile-$name"
  & $browser --headless=new --disable-gpu --disable-extensions --no-first-run --hide-scrollbars `
    --user-data-dir="$profile" --force-device-scale-factor=1 --window-size=1440,$height `
    --virtual-time-budget=2500 --screenshot="$out" "$base$path" 2>&1 | Out-Null
  if (Test-Path $out) { Write-Host ("  ok  {0,-12} {1} KB" -f $name, [math]::Round((Get-Item $out).Length / 1KB)) -ForegroundColor Green }
  else { Write-Host "  FAIL $name" -ForegroundColor Red }
}

try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 200; if ((& curl.exe -s -o NUL -w '%{http_code}' "$base/readyz") -eq '200') { $ready = $true; break } }
  if (-not $ready) { throw '服务未就绪' }

  & $exe set-password demo $Password | Out-Null
  & curl.exe -s -c $jar -o NUL -H "Origin: $base" -X POST -d 'account=demo' -d "password=$Password" "$base/login" | Out-Null

  # 造几篇演示帖（demo 是超级管理员 → 直接放行，不卡审核）
  $posts = @(
    @{ kind = 'discussion'; title = '新人报到与社区说明'; body = '这里是星际争霸 II 的社区站。发帖分三类：讨论、资源、转载。游客可以浏览，注册激活后即可发帖回复。' },
    @{ kind = 'resource';   title = '弥音启动器 0.1.0-alpha.1'; body = '战役管理、补丁合成与导出已经可用。安装包不在本站托管，下载入口见 https://github.com/Tang-Tian-dev/SC2clud' },
    @{ kind = 'repost';     title = '转载：战役安装排错指南'; body = '整理自社区的常见问题与排查顺序，原文见 https://example.com/guide 。' },
    @{ kind = 'discussion'; title = '卡片四：图集与排版测试'; body = '这一条用来检查卡片在标题较长、正文较长时的排版与等高效果。' }
  )
  $ids = @()
  foreach ($p in $posts) {
    $json = @{ title = $p.title; body = $p.body; kind = $p.kind } | ConvertTo-Json -Compress
    $file = Join-Path $work 'p.json'
    [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding $false))
    $resp = & curl.exe -s -b $jar -H 'content-type: application/json' --data-binary "@$file" "$base/api/v1/posts"
    $ids += [int][regex]::Match($resp, '"id":(\d+)').Groups[1].Value
  }

  # 给前两篇配图（直接拿站内美术资源当测试图），卡片封面就来自这里。
  $artDir = Join-Path $PSScriptRoot '..\crates\sc2clud-web\static\art'
  $artFiles = @('miyin-wink-520.webp', 'miyin-portrait-320.webp')
  for ($i = 0; $i -lt $artFiles.Count -and $i -lt $ids.Count; $i++) {
    $img = Join-Path $artDir $artFiles[$i]
    if (Test-Path $img) {
      $up = & curl.exe -s -b $jar -X POST --data-binary "@$img" "$base/api/v1/posts/$($ids[$i])/images"
      Write-Host ("  配图 {0} -> {1}" -f $artFiles[$i], $up.Trim())
    }
  }
  if ($ids.Count -gt 0) {
    & curl.exe -s -b $jar -o NUL -H "Origin: $base" -H 'content-type: application/json' --data-binary '{"body":"第一条回复，用来检查详情页排版。"}' "$base/p/$($ids[0])/comments" | Out-Null
  }

  Snap '/' 'home' 1500
  if ($ids.Count -gt 0) { Snap "/p/$($ids[0])" 'post' 1400 }
  Snap '/login' 'login' 900
  Snap '/register' 'register' 1000
  Write-Host "截图输出：$OutDir"
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
