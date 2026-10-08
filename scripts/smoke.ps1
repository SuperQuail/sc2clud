# ============================================================
# SC2clud 冒烟测试
# ------------------------------------------------------------
# 自包含：自己拉起服务、跑完检查、自己收尾。CI 与本地都能用。
#
#   1. 健康/就绪探针
#   2. 流式上传（含中文文件名）
#   3. 盘上内容寻址路径与字节级一致性
#   4. 秒传（claim）
#   5. 下载跳转 + nginx secure_link 签名独立校验
#   6. 超限拒绝（413）且不留下截断内容
#   7. 软删除与 404
#
# 用法：pwsh -File scripts/smoke.ps1   （Windows PowerShell 5.1 与 PowerShell 7 均可）
# 注意：脚本只用 5.1 也支持的语法（不用 -SkipHttpErrorCheck），部署机不必装 PS7。
# ============================================================

param(
    [string]$Exe = '',
    [int]$Port = 18080,
    [string]$Secret = 'smoke-secret'
)

$ErrorActionPreference = 'Stop'
$script:failures = 0

function Ok($msg) { Write-Host "  ok  $msg" -ForegroundColor Green }
function Bad($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; $script:failures++ }
function Assert($cond, $msg) { if ($cond) { Ok $msg } else { Bad $msg } }

# PS 5.1 的 Get-Content 对无 BOM 文件按 ANSI 解码，会把 UTF-8 中文读成乱码；
# 这里显式指定编码，保证测的是服务端行为而不是客户端编码 bug。
function ReadJsonUtf8($path) {
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

if (-not $Exe) {
    $Exe = Join-Path $PSScriptRoot '..\target\debug\sc2clud.exe'
    if (-not (Test-Path $Exe)) {
        $Exe = Join-Path $PSScriptRoot '..\target\debug\sc2clud'
    }
}
if (-not (Test-Path $Exe)) {
    Write-Host "找不到可执行文件：$Exe`n请先 cargo build -p sc2clud-app" -ForegroundColor Red
    exit 2
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('sc2clud-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$base = 'http://127.0.0.1:' + $Port

# 单文件上限设成 64 KiB：既能传成功，又能用小文件触发 413。
$env:SC2CLUD_DATA_DIR = $work
$env:SC2CLUD_DOWNLOAD_SECRET = $Secret
$env:SC2CLUD_BIND = "127.0.0.1:$Port"
$env:SC2CLUD_BASE_URL = $base
$env:SC2CLUD_LOG = 'warn'
$env:SC2CLUD_MAX_UPLOAD_BYTES = '65536'

$stdout = Join-Path $work 'server.out.log'
$stderr = Join-Path $work 'server.err.log'
$proc = Start-Process -FilePath $Exe -ArgumentList 'serve' -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr

try {
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 200
        $probe = & curl.exe -s -o NUL -w '%{http_code}' "$base/readyz"
        if ($probe -eq '200') { $ready = $true; break }
    }
    if (-not $ready) {
        Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | Select-Object -Last 40 | Out-Host
        throw '服务未能在 12 秒内就绪'
    }
    Ok 'readyz 返回 200'

    # ---------- 1. 探针 ----------
    $health = Invoke-RestMethod -Uri "$base/healthz" -TimeoutSec 5
    Assert ($health.status -eq 'ok') 'healthz 返回 status=ok'

    # ---------- 2. 上传 ----------
    $src = Join-Path $work 'payload.bin'
    $bytes = New-Object byte[] 8192
    (New-Object System.Random -ArgumentList 42).NextBytes($bytes)
    [System.IO.File]::WriteAllBytes($src, $bytes)
    $srcMd5 = (Get-FileHash -Path $src -Algorithm MD5).Hash

    $name = [uri]::EscapeDataString('地图 包.bin')
    $code = & curl.exe -s -o (Join-Path $work 'upload.json') -w '%{http_code}' -X PUT --data-binary "@$src" "$base/api/v1/files?name=$name&mime=application%2Foctet-stream"
    $uploaded = ReadJsonUtf8 (Join-Path $work 'upload.json')
    Assert ($code -eq '200') "上传返回 200（实际 $code）"
    Assert ($uploaded.size -eq 8192) "返回 size = 8192（实际 $($uploaded.size)）"
    Assert ($uploaded.deduplicated -eq $false) '首次上传 deduplicated=false'
    Assert ($uploaded.name -eq '地图 包.bin') "中文文件名原样保留（实际 $($uploaded.name)）"
    Assert ($uploaded.hash.Length -eq 64) '返回 64 位 blake3 摘要'

    # ---------- 3. 盘上内容寻址 + 字节级一致 ----------
    $hash = $uploaded.hash
    $blob = Join-Path $work ("blobs\" + $hash.Substring(0, 2) + '\' + $hash.Substring(2, 2) + '\' + $hash)
    Assert (Test-Path $blob) "内容落在 blobs/<ab>/<cd>/<hash>"
    if (Test-Path $blob) {
        $blobMd5 = (Get-FileHash -Path $blob -Algorithm MD5).Hash
        Assert ($blobMd5 -eq $srcMd5) '盘上字节与源文件逐字节一致'
    }
    $parts = Get-ChildItem (Join-Path $work 'blobs\tmp') -ErrorAction SilentlyContinue
    Assert ($null -eq $parts -or $parts.Count -eq 0) '中转目录已清空（无 .part 残留）'

    # ---------- 4. 秒传 ----------
    $claimBody = @{ name = '副本.bin'; hash = $hash; size = 8192 } | ConvertTo-Json -Compress
    $claim = Invoke-RestMethod -Uri "$base/api/v1/files/claim" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($claimBody))
    Assert ($claim.deduplicated -eq $true) '秒传命中并返回 deduplicated=true'
    Assert ($claim.size -eq 8192) '秒传复用同一份内容（size 一致）'

    # 走文件而不是命令行参数：PS 5.1 传原生命令行时会吞掉 JSON 里的引号。
    $wrongPath = Join-Path $work 'claim-wrong.json'
    $wrong = @{ name = 'x.bin'; hash = $hash; size = 999 } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($wrongPath, $wrong, (New-Object System.Text.UTF8Encoding $false))
    $wrongCode = & curl.exe -s -o NUL -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary "@$wrongPath" "$base/api/v1/files/claim"
    Assert ($wrongCode -eq '409') "声明体积不符被拒绝（409，实际 $wrongCode）"

    # ---------- 5. 下载跳转 + 签名独立校验 ----------
    $dl = & curl.exe -s -o NUL -w '%{http_code}|%{redirect_url}' "$base/api/v1/files/$($uploaded.id)/download"
    $dlParts = $dl -split '\|'
    $dlStatus = $dlParts[0]
    $location = $dlParts[-1]
    Assert ($dlStatus -eq '302') "下载返回 302（实际 $dlStatus）"
    Assert ($location -match '/dl/') '跳转目标是 /dl/ 下的受保护路径'

    $uri = [uri]$location
    $dlPath = $uri.AbsolutePath
    $q = @{}
    foreach ($kv in $uri.Query.TrimStart('?').Split('&')) {
        $pair = $kv.Split('=', 2)
        if ($pair.Count -eq 2) { $q[$pair[0]] = $pair[1] }
    }
    $expires = [int64]$q['e']
    $sig = $q['s']
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    Assert ($expires -gt $now) '签名带未来过期时间'
    Assert ($expires -le ($now + 400)) 'TTL 是短时（≤ 400 秒）'
    Assert ($dlPath.EndsWith($hash)) '受保护路径包含内容摘要'

    # 用 Windows CNG 独立复算 nginx secure_link_md5 的表达式：
    #   "$secure_link_expires$uri$remote_addr 再拼一个空格与 secret"
    $cnc = [System.Security.Cryptography.MD5]::Create()
    $expr = "$expires$dlPath" + '127.0.0.1' + " $Secret"
    $digest = $cnc.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($expr))
    $expected = [Convert]::ToBase64String($digest).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    Assert ($sig -eq $expected) '签名与 nginx secure_link_md5 表达式逐字节一致'

    # ---------- 6. 超限拒绝：不得留下截断内容 ----------
    $big = Join-Path $work 'big.bin'
    [System.IO.File]::WriteAllBytes($big, (New-Object byte[] 131072))
    $bigCode = & curl.exe -s -o (Join-Path $work 'big.json') -w '%{http_code}' -X PUT --data-binary "@$big" "$base/api/v1/files?name=big.bin"
    Assert ($bigCode -eq '413') "超出单文件上限被拒（413，实际 $bigCode）"

    $tmpLeft = Get-ChildItem (Join-Path $work 'blobs\tmp') -ErrorAction SilentlyContinue
    Assert ($null -eq $tmpLeft -or $tmpLeft.Count -eq 0) '超限请求清理了中转文件'
    $blobsAfter = @(Get-ChildItem (Join-Path $work 'blobs') -Recurse -File -ErrorAction SilentlyContinue)
    Assert ($blobsAfter.Count -eq 1) "盘上仍只有 1 份内容（实际 $($blobsAfter.Count)）"

    # ---------- 7. 引用计数：删掉一个引用不动内容，全部删掉才回收 ----------
    $del1 = & curl.exe -s -o NUL -w '%{http_code}' -X DELETE "$base/api/v1/files/$($uploaded.id)"
    Assert ($del1 -eq '204') "删除第一个引用返回 204（实际 $del1）"
    $stillThere = @(Get-ChildItem (Join-Path $work 'blobs') -Recurse -File -ErrorAction SilentlyContinue)
    Assert ($stillThere.Count -eq 1) '仍有其他引用时，物理内容保留'

    $del2 = & curl.exe -s -o NUL -w '%{http_code}' -X DELETE "$base/api/v1/files/$($claim.id)"
    Assert ($del2 -eq '204') "删除第二个引用返回 204（实际 $del2）"
    $gone = @(Get-ChildItem (Join-Path $work 'blobs') -Recurse -File -ErrorAction SilentlyContinue)
    Assert ($gone.Count -eq 0) '引用归零后物理内容被回收'

    $pageCode = & curl.exe -s -o NUL -w '%{http_code}' -H 'accept: text/html' "$base/f/$($uploaded.id)"
    Assert ($pageCode -eq '404') "删除后详情页 404（实际 $pageCode）"
    $homeCode = & curl.exe -s -o NUL -w '%{http_code}' -H 'accept: text/html' "$base/"
    Assert ($homeCode -eq '200') "首页服务端渲染 200（实际 $homeCode）"

    # ---------- 8. 写回缓冲：下载计数最终落库 ----------
    $sqlite = (Get-Command sqlite3 -ErrorAction SilentlyContinue).Source
    if ($sqlite) {
        Start-Sleep -Seconds 12   # 刷盘间隔 10 秒
        $value = & $sqlite (Join-Path $work 'sc2clud.sqlite3') "SELECT value FROM counters WHERE key='file:$($uploaded.id):downloads';"
        Assert ($value -eq '1') "下载计数已批量落库（实际 $value）"
    } else {
        Write-Host '  --  跳过计数落库检查（未找到 sqlite3）' -ForegroundColor Yellow
    }

    if ($script:failures -gt 0) {
        Write-Host "冒烟测试失败：$($script:failures) 项" -ForegroundColor Red
        Write-Host "工作目录保留在：$work"
        exit 1
    }
    Write-Host '冒烟测试全部通过' -ForegroundColor Green
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    }
}
