# ============================================================
# SC2clud 冒烟测试（自包含：自己拉起服务、跑完检查、自己收尾）
#
# 覆盖：探针 → 未登录不得访问 → 口令重置 → 登录 → 上传 → 盘上一致性 → 秒传 →
#       签名 → 超限 → 引用计数回收 → 游客首页不泄露
#
# 用法：pwsh -File scripts/smoke.ps1   （PS 5.1 与 pwsh 7 均可）
# ============================================================

param([int]$Port = 18080, [string]$Password = 'smoke-pass')

$ErrorActionPreference = 'Continue'
$script:failures = 0
function Ok($m) { Write-Host "  ok  $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  FAIL $m" -ForegroundColor Red; $script:failures++ }
function Assert($cond, $m) { if ($cond) { Ok $m } else { Bad $m } }

$exe = Join-Path $PSScriptRoot '..\target\debug\sc2clud.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $PSScriptRoot '..\target\debug\sc2clud' }
if (-not (Test-Path $exe)) { Write-Host '找不到可执行文件，请先 cargo build -p sc2clud-app' -ForegroundColor Red; exit 2 }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('sc2clud-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$base = 'http://127.0.0.1:' + $Port
$jar = Join-Path $work 'cookies.txt'

$env:SC2CLUD_DATA_DIR = $work
$env:SC2CLUD_DOWNLOAD_SECRET = 'smoke-secret'
$env:SC2CLUD_BIND = "127.0.0.1:$Port"
$env:SC2CLUD_BASE_URL = $base
$env:SC2CLUD_LOG = 'warn'
$env:SC2CLUD_MAX_UPLOAD_BYTES = '65536'

$proc = Start-Process -FilePath $exe -ArgumentList 'serve' -PassThru -NoNewWindow -RedirectStandardOutput "$work\out.log" -RedirectStandardError "$work\err.log"
try {
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 200; if ((& curl.exe -s -o NUL -w '%{http_code}' "$base/readyz") -eq '200') { $ready = $true; break } }
    if (-not $ready) { Get-Content "$work\out.log","$work\err.log" -ErrorAction SilentlyContinue | Select-Object -Last 30 | Out-Host; throw '服务未能就绪' }
    Ok 'readyz 返回 200'
    Assert ((& curl.exe -s "$base/healthz") -match '"ok"') 'healthz 返回 status=ok'

    Assert ((& curl.exe -s -o NUL -w '%{http_code}' "$base/api/v1/files") -eq '401') '未登录访问文件列表 → 401'
    $guestHome = & curl.exe -s "$base/"
    Assert ($guestHome -notmatch '我的文件') '游客首页不显示任何人的网盘内容'
    Assert ($guestHome -match '登录') '游客首页给出登录入口'

    & $exe set-password demo $Password | Out-Null
    $login = & curl.exe -s -c $jar -o NUL -w '%{http_code}' -H "Origin: $base" -X POST -d 'account=demo' -d "password=$Password" "$base/login"
    Assert (($login -eq '303') -or ($login -eq '302')) "登录成功并下发会话（实际 $login）"
    Assert (Select-String -Path $jar -Pattern 'sc2clud_session' -Quiet) '会话 Cookie 已保存'
    Assert ((& curl.exe -s -b $jar -o NUL -w '%{http_code}' "$base/api/v1/files") -eq '200') '登录后文件列表 200'

    $src = Join-Path $work 'payload.bin'
    $bytes = New-Object byte[] 8192
    (New-Object System.Random -ArgumentList 42).NextBytes($bytes)
    [System.IO.File]::WriteAllBytes($src, $bytes)
    $srcMd5 = (Get-FileHash $src -Algorithm MD5).Hash
    $name = [uri]::EscapeDataString('地图 包.bin')
    $code = & curl.exe -s -b $jar -o "$work\upload.json" -w '%{http_code}' -X PUT --data-binary "@$src" "$base/api/v1/files?name=$name"
    $uploaded = [System.IO.File]::ReadAllText("$work\upload.json", [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert ($code -eq '200') "上传返回 200（实际 $code）"
    Assert ($uploaded.size -eq 8192) '返回 size = 8192'
    Assert ($uploaded.name -eq '地图 包.bin') '中文文件名原样保留'
    $hash = $uploaded.hash
    $blob = Join-Path $work ("blobs\" + $hash.Substring(0,2) + '\' + $hash.Substring(2,2) + '\' + $hash)
    Assert (Test-Path $blob) '内容落在 blobs/<ab>/<cd>/<hash>'
    if (Test-Path $blob) { Assert ((Get-FileHash $blob -Algorithm MD5).Hash -eq $srcMd5) '盘上字节与源文件逐字节一致' }
    $parts = Get-ChildItem (Join-Path $work 'blobs\tmp') -ErrorAction SilentlyContinue
    Assert ($null -eq $parts -or $parts.Count -eq 0) '中转目录已清空'

    $claimBody = @{ name = '副本.bin'; hash = $hash; size = 8192 } | ConvertTo-Json -Compress
    $claimPath = Join-Path $work 'claim.json'
    [System.IO.File]::WriteAllText($claimPath, $claimBody, (New-Object System.Text.UTF8Encoding $false))
    $claim = & curl.exe -s -b $jar -H 'content-type: application/json' --data-binary "@$claimPath" "$base/api/v1/files/claim" | ConvertFrom-Json
    Assert ($claim.deduplicated -eq $true) '秒传命中并返回 deduplicated=true'

    $dl = & curl.exe -s -b $jar -o NUL -w '%{http_code}|%{redirect_url}' "$base/api/v1/files/$($uploaded.id)/download"
    $dlParts = $dl -split '\|'
    Assert ($dlParts[0] -eq '302') "下载返回 302（实际 $($dlParts[0])）"
    $uri = [uri]$dlParts[-1]
    $q = @{}; foreach ($kv in $uri.Query.TrimStart('?').Split('&')) { $p = $kv.Split('=',2); if ($p.Count -eq 2) { $q[$p[0]] = $p[1] } }
    $expr = "$($q['e'])$($uri.AbsolutePath)" + '127.0.0.1 smoke-secret'
    $digest = [System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($expr))
    $expected = [Convert]::ToBase64String($digest).TrimEnd('=').Replace('+','-').Replace('/','_')
    Assert ($q['s'] -eq $expected) '签名与 nginx secure_link_md5 表达式逐字节一致'

    $big = Join-Path $work 'big.bin'
    [System.IO.File]::WriteAllBytes($big, (New-Object byte[] 131072))
    $bigCode = & curl.exe -s -b $jar -o NUL -w '%{http_code}' -X PUT --data-binary "@$big" "$base/api/v1/files?name=big.bin"
    Assert ($bigCode -eq '413') "超限被拒（413，实际 $bigCode）"
    Assert (@(Get-ChildItem (Join-Path $work 'blobs') -Recurse -File -ErrorAction SilentlyContinue).Count -eq 1) '盘上仍只有 1 份内容'

    Assert ((& curl.exe -s -b $jar -o NUL -w '%{http_code}' -X DELETE "$base/api/v1/files/$($uploaded.id)") -eq '204') '删除第一个引用 204'
    Assert (@(Get-ChildItem (Join-Path $work 'blobs') -Recurse -File -ErrorAction SilentlyContinue).Count -eq 1) '仍有引用时内容保留'
    Assert ((& curl.exe -s -b $jar -o NUL -w '%{http_code}' -X DELETE "$base/api/v1/files/$($claim.id)") -eq '204') '删除第二个引用 204'
    Assert (@(Get-ChildItem (Join-Path $work 'blobs') -Recurse -File -ErrorAction SilentlyContinue).Count -eq 0) '引用归零后回收物理内容'

    if ($script:failures -gt 0) { Write-Host "冒烟测试失败：$($script:failures) 项" -ForegroundColor Red; Write-Host "工作目录：$work"; exit 1 }
    Write-Host '冒烟测试全部通过' -ForegroundColor Green
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
