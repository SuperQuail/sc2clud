# 盲测公共库：把本地文件（base64 存根）送到 dev 并执行。
# 用 pwsh 的 here-string 省掉一切引号地狱；ssh 走 cmd 重定向（见 remote.ps1 的注释）。

function Send-BtScript {
  param(
    [Parameter(Mandatory=$true)][string]$LocalDir,
    [Parameter(Mandatory=$true)][string]$RemoteDir = '/tmp/blindtest'
  )
  $files = Get-ChildItem -Path $LocalDir -Filter '*.b64' -File
  if (-not $files) { throw "没有 .b64 存根：$LocalDir" }
  $gens = @()
  foreach ($f in $files) {
    $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    $b = [IO.File]::ReadAllText($f.FullName).Trim()
    $gens += "printf '%s' '$b' | base64 -d > '$RemoteDir/$name'"
  }
  $body = @"
set -e
mkdir -p '$RemoteDir'
$($gens -join "`n")
chmod 0644 '$RemoteDir'/*
ls -l '$RemoteDir'
"@
  $tmp = Join-Path $env:TEMP ('bt-gen-' + [Guid]::NewGuid().ToString('N') + '.sh')
  [IO.File]::WriteAllText($tmp, $body, (New-Object Text.UTF8Encoding($false)))
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'remote.ps1') -Body $tmp
  } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
