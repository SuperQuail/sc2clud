# SC2clud deploy transport wrapper. Invoked as:
#   cmd.exe /c "powershell -File .ssh-run.ps1 -Target <host> -KeyPath <key> < <bodyfile>"
#
# stdin is the bash body (raw bytes, thanks to cmd's '<' redirect: PowerShell's
# string encoding never touches it). stdout is @{Code;Out} as JSON.
#
# It does NOT run ssh itself. Every ssh invocation seen so far that went through
# PowerShell's script-block or argument path picked up a UTF-8 BOM on the body's
# first line, and the remote bash answered 'set: command not found'. A one-line
# .bat whose redirect comes straight from the shell has none of that: verified
# byte-for-byte with 'od -c' on the far side.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$KeyPath
)

$ErrorActionPreference = 'Stop'
$NL = [Environment]::NewLine

$tag = [Guid]::NewGuid().ToString('N')
$body = Join-Path $env:TEMP ('sc2clud-body-' + $tag + '.sh')
$outFile = Join-Path $env:TEMP ('sc2clud-out-' + $tag + '.txt')
$errFile = Join-Path $env:TEMP ('sc2clud-err-' + $tag + '.txt')
$bat = Join-Path $env:TEMP ('sc2clud-run-' + $tag + '.bat')

try {
  $stdin = [Console]::OpenStandardInput()
  $sink = [IO.File]::Create($body)
  $stdin.CopyTo($sink)
  $sink.Flush()
  $sink.Close()

  $line = 'ssh -i "' + $KeyPath + '" -o BatchMode=yes -o ConnectTimeout=15 ' + $Target + ' bash -s'
  [IO.File]::WriteAllText($bat, '@echo off' + $NL + $line + ' < "' + $body + '" 1> "' + $outFile + '" 2> "' + $errFile + '"' + $NL, [Text.Encoding]::ASCII)

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/c "' + $bat + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()

  $out = ''
  if (Test-Path $outFile) { $out = [IO.File]::ReadAllText($outFile) }
  $err = ''
  if (Test-Path $errFile) { $err = [IO.File]::ReadAllText($errFile) }

  $result = @{ Code = $proc.ExitCode; Out = ($out + $err).TrimEnd() }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress))
}
finally {
  Remove-Item $body, $outFile, $errFile, $bat -ErrorAction SilentlyContinue
}
