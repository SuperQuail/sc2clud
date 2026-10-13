# ============================================================
# SC2clud deploy helpers. Dot-sourced by deploy/*.ps1; not run directly.
#
# Requires $Instance ('dev' | 'prod') to be set by the caller before dot-sourcing.
# Defines the layout constants and the one transport used to talk to the server:
# every remote call base64-encodes the library plus one script from
# deploy/remote/*.sh and pipes it to 'bash', '-s'. No scp, and no layer quoting
# another layer's quoting.
#
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less UTF-8
# as ANSI, which corrupts the script instead of just garbling a message).
# ============================================================

# lib.ps1 is dot-sourced, and in a dot-sourced file $PSScriptRoot is the CALLER's
# directory -- not this file's. Anchor on the file itself, or every path below
# silently points one directory too high.
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path  # deploy/
$RepoRoot = Split-Path -Parent $ScriptRoot                  # repository root
$Root = $RepoRoot                                           # kept: callers use $Root
$Sep = [IO.Path]::DirectorySeparatorChar
if (-not $SshKey) { $SshKey = Join-Path $Root ('secrets' + $Sep + 'ssh' + $Sep + 'id_ed25519_deploy') }
if (-not $Server) { $Server = 'root@191.40.41.97' }
$WebDir = Join-Path $Root 'web'
$ForumDir = Join-Path $Root 'forum'
$RemoteDir = Join-Path $Root ('deploy' + $Sep + 'remote')
$ArtifactDir = Join-Path $Root ('deploy' + $Sep + 'artifacts')
$BuildDir = Join-Path $Root ('deploy' + $Sep + '.build')

# Directory contract: prod uses the SAME layout as the dev instance already
# running on the server, just with -prod instead of -dev. The unit name is the
# instance name, and /etc/sc2clud/<instance>.env holds the rest.
$Layout = @{
  # dev 的公开路径是 /dev/（nginx location /dev/ -> 8082）。曾经写成 /dev-go/ —— 那条路径在下
  # nginx 里不存在，会落到 location / -> 8080 的维护占位页，于是每次部署都警告「200 但不是这个 build」。
  dev  = @{ Dir = '/srv/sc2clud-dev'; Addr = '127.0.0.1:8082'; Public = 'http://191.40.41.97/dev/' }
  prod = @{ Dir = '/srv/sc2clud-prod'; Addr = '127.0.0.1:8080'; Public = 'http://191.40.41.97/' }
}
if (-not $Layout.ContainsKey($Instance)) { throw ('unknown instance: ' + $Instance) }
$L = $Layout[$Instance]
$InstanceDir = $L.Dir
$LocalAddr = $L.Addr
$PublicUrl = $L.Public
$UnitName = 'sc2clud@' + $Instance + '.service'
$SshOpts = @('-i', $SshKey, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
# Console output encoding: PowerShell 5.1 defaults to UTF-8 *with BOM*, and a
# BOM in the piped script is what makes bash report "set: command not found".
# ASCII, never UTF-8-with-BOM: PowerShell 5.1 would otherwise prepend a BOM to
# every program argument and every piped line.
$OutputEncoding = New-Object Text.ASCIIEncoding
$LF = [char]10
$CR = [char]13
# Remote scripts are assembled with LF: the box runs bash, and a stray CR turns
# into 'bash: $'\r': command not found'.
$NL = $LF

function Info([string]$m) { Write-Host ('  ' + $m) }
function Warn([string]$m) { Write-Host ('  ' + $m) -ForegroundColor Yellow }
function Stage([string]$m) { Write-Host ''; Write-Host ('[' + $m + ']') -ForegroundColor Cyan }
function Fail([string]$m) { throw $m }
function B64([string]$s) { return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function B64File([string]$p) { return [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) }

function Get-GoExe {
  if ($env:FORUM_GO_EXE -and (Test-Path $env:FORUM_GO_EXE)) { return $env:FORUM_GO_EXE }
  $inTools = Join-Path $RepoRoot ('.tools' + $Sep + 'go' + $Sep + 'bin' + $Sep + 'go.exe')
  if (Test-Path $inTools) { return (Resolve-Path $inTools).Path }
  $cmd = Get-Command go -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  Fail ('go not found (looked at ' + $inTools + ' and PATH). See the repo README.')
}

# The repo keeps its module cache under .tools/, so pin it: a fresh clone should
# not start a 400 MB download just to cross-compile one binary.
function Set-GoEnv {
  $mod = Join-Path $RepoRoot ('.tools' + $Sep + 'gomodcache')
  if (-not $env:GOMODCACHE -and (Test-Path $mod)) { $env:GOMODCACHE = (Resolve-Path $mod).Path }
  $cache = Join-Path $RepoRoot ('.tools' + $Sep + 'gocache')
  if (-not $env:GOCACHE -and (Test-Path $cache)) { $env:GOCACHE = (Resolve-Path $cache).Path }
  if (-not $env:GOPROXY) { $env:GOPROXY = 'https://goproxy.cn,direct' }
}

function Get-BootstrapHeader([hashtable]$EnvVars) {
  $head = 'set -e' + $NL + 'umask 077' + $NL +
    "printf '%s' '" + (B64File (Join-Path $RemoteDir 'lib.sh')) + "' | base64 -d > /tmp/sc2clud-lib.sh" + $NL +
    'chmod 600 /tmp/sc2clud-lib.sh' + $NL
  if ($EnvVars -and $EnvVars.ContainsKey('__UNIT__')) {
    $head += "printf '%s' '" + $EnvVars['__UNIT__'] + "' | base64 -d > /tmp/sc2clud-unit.service" + $NL +
      'chmod 600 /tmp/sc2clud-unit.service' + $NL
  }
  if ($EnvVars) {
    foreach ($k in $EnvVars.Keys) {
      if ($k.StartsWith('__')) { continue }
      $head += 'export ' + $k + "='" + $EnvVars[$k] + "'" + $NL
    }
  }
  return $head
}

# Send one bash body to the server and return @{ Code; Out }.
#
# Everything about how this reaches ssh is load-bearing:
#   - the body goes to a temp FILE and is redirected into the wrapper with cmd's
#     '<' so it arrives as raw bytes. Piping a PowerShell string to a native
#     command re-encodes it as UTF-8 WITH a BOM and as CRLF, and bash then reports
#     'set: command not found' on line 1 plus a stray CR on every line;
#   - the wrapper is invoked through -File, not inline: an inline command line
#     gets a BOM prepended, which would land on the body's first line.
function Invoke-Ssh([string]$Body) {
  $tag = [Guid]::NewGuid().ToString('N')
  $bodyFile = Join-Path $env:TEMP ('sc2clud-body-' + $tag + '.sh')
  [IO.File]::WriteAllBytes($bodyFile, [Text.Encoding]::ASCII.GetBytes($Body))
  try {
    $wrapper = Join-Path $ScriptRoot '.ssh-run.ps1'
    # One batch file, one line: everything on it is a path in double quotes, so
    # there is no nested-quoting puzzle between PowerShell, cmd and ssh.
    $bat = Join-Path $env:TEMP ('sc2clud-run-' + $tag + '.bat')
    $line = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $wrapper + '" -Target "' + $Server +
      '" -KeyPath "' + $SshKey + '"'
    [IO.File]::WriteAllText($bat, '@echo off' + [Environment]::NewLine + $line + ' < "' + $bodyFile + '"' + [Environment]::NewLine, [Text.Encoding]::ASCII)
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c "' + $bat + '"'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $psi.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $proc = [Diagnostics.Process]::Start($psi)
    $out = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $json = $out.Trim()
    if (-not $json) {
      return @{ Code = 255; Out = ('transport failed (cmd exit ' + $proc.ExitCode + '): ' + $err.Trim()) }
    }
    try {
      $obj = $json | ConvertFrom-Json
      return @{ Code = [int]$obj.Code; Out = [string]$obj.Out }
    }
    catch {
      return @{ Code = 255; Out = ('transport returned unparseable output: ' + $json + ' / stderr: ' + $err.Trim()) }
    }
  }
  finally {
    Remove-Item $bodyFile -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:TEMP ('sc2clud-run-' + $tag + '.bat')) -ErrorAction SilentlyContinue
  }
}

function Invoke-Remote([string]$Name, [hashtable]$EnvVars, [switch]$AllowFail) {
  $scriptPath = Join-Path $RemoteDir ($Name + '.sh')
  if (-not (Test-Path $scriptPath)) { Fail ('no such remote script: ' + $scriptPath) }
  $body = (Get-BootstrapHeader $EnvVars) + $LF + "set -e" + $LF + "printf '%s' '" + (B64File $scriptPath) + "' | base64 -d | bash"
  $res = Invoke-Ssh $body
  if ($res.Code -ne 0 -and -not $AllowFail) {
    Fail ('remote ' + $Name + '.sh failed (exit ' + $res.Code + '):' + $NL + $res.Out)
  }
  return $res
}

# For one-off commands. The leading ':' absorbs a UTF-8 BOM that an inline
# PowerShell wrapper prepends to the first line of the here-string it passes to
# bash (observed as 'bash: line 1: <BOM>set: command not found'). Harmless when
# there is no BOM. Invoke-Remote must NOT get this prefix: Get-BootstrapHeader
# already produced its first line.
function Invoke-RemoteRaw([string]$Script) {
  $body = ':' + $LF + (Get-BootstrapHeader $null) + $LF + "set -e" + $LF + "printf '%s' '" + (B64 $Script) + "' | base64 -d | bash"
  return Invoke-Ssh $body
}

# Binary-safe upload. scp is not used: it would need a second binary, a second
# set of options, and quoting that differs between OpenSSH builds on Windows.
function Put-File([string]$Local, [string]$Remote) {
  $len = (Get-Item $Local).Length
  Info ('uploading ' + (Split-Path -Leaf $Local) + ' (' + [math]::Round($len / 1MB, 1) + ' MB)')
  $script = "base64 -d > '" + $Remote + ".tmp' <<'SC2CLUD_B64_EOF'" + $LF + (B64File $Local) + $LF + 'SC2CLUD_B64_EOF' + $LF +
    "mv -f '" + $Remote + ".tmp' '" + $Remote + "'" + $LF +
    "chmod 644 '" + $Remote + "'" + $LF +
    "test -s '" + $Remote + "' || { echo 'upload produced an empty file'; exit 1; }"
  $res = Invoke-Ssh $script
  if ($res.Code -ne 0) { Fail ('upload to ' + $Remote + ' failed:' + $LF + $res.Out) }
}

function Read-RemoteFile([string]$Path, [string]$Inst) {
  return (Invoke-Remote 'envread' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Inst; SC2CLUD_READ = $Path }).Out.Trim()
}

function Get-RemoteLink([string]$Path, [string]$Inst) {
  return (Invoke-RemoteRaw ("readlink '" + $Path + "' 2>/dev/null || true")).Out.Trim()
}

function Get-EnvB64([string]$Inst) { return (Read-RemoteFile ('/etc/sc2clud/' + $Inst + '.env') $Inst) }

function Invoke-Curl([string]$Url) {
  $bodyFile = Join-Path $env:TEMP 'sc2clud-curl-body'
  $raw = & curl.exe -s -m 10 -o $bodyFile -w '%{http_code}' $Url 2>&1
  $code = (($raw | ForEach-Object { [string]$_ }) -join '').Trim()
  $body = ''
  if (Test-Path $bodyFile) { $body = Get-Content -Raw $bodyFile }
  return @{ Code = $code; Body = $body }
}

# Parse 'key=value' lines into a hashtable. The remote health probe prints facts
# this way so a failed probe is data, never a swallowed error.
function ConvertFrom-Facts([string]$Text) {
  $facts = @{}
  foreach ($line in ($Text -split "`n")) {
    $t = $line.TrimEnd()
    if (-not $t) { continue }
    $i = $t.IndexOf('=')
    if ($i -gt 0) { $facts[$t.Substring(0, $i)] = $t.Substring($i + 1) }
  }
  return $facts
}
