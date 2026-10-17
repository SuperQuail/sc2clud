# 盲测用远端执行封装（只读，不碰部署脚本）。
# 用法： pwsh -File scripts/blindtest/remote.ps1 -Body <本地 sh 文件>
# 存在原因：PowerShell 的管道会把 LF 转成 CRLF，base64 过 ssh 时 'invalid input'。
# 走 cmd.exe 的 '<' 重定向，字节原样进 ssh 的 stdin，远端 'bash -s' 执行。
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$Target = 'root@191.40.41.97',
  [string]$KeyPath = 'secrets/ssh/id_ed25519_deploy'
)
$ErrorActionPreference = 'Stop'
$NL = [Environment]::NewLine
$tag = [Guid]::NewGuid().ToString('N')
$bat = Join-Path $env:TEMP ('bt-run-' + $tag + '.bat')
$out = Join-Path $env:TEMP ('bt-out-' + $tag + '.txt')
$err = Join-Path $env:TEMP ('bt-err-' + $tag + '.txt')
$full = (Resolve-Path $Body).Path
try {
  $line = 'ssh -i "' + (Resolve-Path $KeyPath).Path + '" -o BatchMode=yes -o StrictHostKeyChecking=no ' + $Target + ' bash -s'
  [IO.File]::WriteAllText($bat, '@echo off' + $NL + $line + ' < "' + $full + '" 1> "' + $out + '" 2> "' + $err + '"' + $NL, [Text.Encoding]::ASCII)
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $bat + '"') -NoNewWindow -Wait -PassThru
  $o = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '' }
  $e = if (Test-Path $err) { [IO.File]::ReadAllText($err) } else { '' }
  [Console]::Out.Write($o)
  if ($e) { [Console]::Error.Write($e) }
  exit $p.ExitCode
} finally {
  Remove-Item $bat, $out, $err -ErrorAction SilentlyContinue
}
