# ============================================================
# SC2clud deploy -- the one command that puts a build on a server instance.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 dev
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 prod
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 dev -HealthPath /nope
#
# Order (fixed; see the P3 design section):
#   build -> pack + sha256 -> upload -> install (unpack/verify/switch) -> BACKUP DB
#   -> stop -> migrate -> start -> health -> rollback on failure
#
# What this script deliberately does NOT do:
#   - it never writes to nginx. The vhost, /dev/ and /devroom/ are hand-edited on
#     the box; see deploy/nginx-sc2clud.md for the two lines that actually matter.
#     A deploy tool that rewrites a live vhost is how the last site broke.
#   - it never restores the database. A migration is not undone by a code
#     rollback, so the script says that out loud and prints the restore command.
#   - it never compiles on the server. The server has no node and no go, so
#     web/dist and bin/forum arrive already built.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8 as
# ANSI, and non-ASCII bytes here corrupt the script instead of just garbling a
# message. The remote half lives in deploy/remote/*.sh; reasoning in README.md.
# ============================================================
[CmdletBinding()]
param(
  # 'prod' installs to /srv/sc2clud-prod (127.0.0.1:8080, nginx location /).
  # 'dev'  installs to /srv/sc2clud-dev  (127.0.0.1:8082, no public route yet).
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('dev', 'prod')]
  [string]$Instance,

  # Release name. Default: the git short sha of the working tree.
  [string]$Version,

  [string]$SshKey,
  [string]$Server = 'root@191.40.41.97',

  # Run 'pnpm build' + cross-compile. Without -SkipBuild a broken frontend build
  # stops the deploy here -- that is the point of a gate.
  [switch]$SkipBuild,
  # Skip pg_dump. Drill only; a real deploy must not skip it.
  [switch]$SkipDbBackup,
  # Probe this path instead of /healthz (rollback drill).
  [string]$HealthPath = '/healthz',
  # Force a wrong web version so the post-deploy version check fails (drill).
  [string]$BadWebVersion,
  # Leave the failed release in place instead of rolling back.
  [switch]$NoRollback,
  # Ship the existing web/dist even when 'pnpm build' fails. Without this a
  # broken frontend build stops the deploy -- which is the point of the gate.
  [switch]$AllowStaleWeb
)

$ErrorActionPreference = 'Stop'
# A BOM in the piped remote script makes bash report "set: command not found".
$OutputEncoding = New-Object Text.ASCIIEncoding
Set-StrictMode -Version Latest

# The layout, the transport and the small helpers live in lib.ps1: the same
# code has to serve deploy / status / promote / rollback, and a second copy is
# how two of them silently drift apart.
. (Join-Path $PSScriptRoot 'lib.ps1')
function Invoke-Curl([string]$Url) {
  $bodyFile = Join-Path $env:TEMP 'sc2clud-curl-body'
  $raw = & curl.exe -s -m 10 -o $bodyFile -w '%{http_code}' $Url 2>&1
  $code = (($raw | ForEach-Object { [string]$_ }) -join '').Trim()
  $body = ''
  if (Test-Path $bodyFile) { $body = Get-Content -Raw $bodyFile }
  return @{ Code = $code; Body = $body }
}

# ---------------------------------------------------------------- steps
function Step-Build([string]$Ver) {
  Stage '1/9 build'
  if ($SkipBuild) {
    Info 'SKIPPED (-SkipBuild): packing whatever is in web/dist right now'
  }
  else {
    Set-GoEnv
    Info 'web: pnpm build'
    Push-Location $WebDir
    try { & pnpm build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) {
      if ($AllowStaleWeb) {
        Warn ('frontend build FAILED (exit ' + $LASTEXITCODE + '), continuing with the existing web/dist because -AllowStaleWeb was passed')
      }
      else {
        Fail ('frontend build failed (exit ' + $LASTEXITCODE + '). Fix it, or pass -AllowStaleWeb to ship the existing web/dist on purpose.')
      }
    }
    Info 'forum: GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build'
    $go = Get-GoExe
    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
    Push-Location $ForumDir
    try {
      $env:GOOS = 'linux'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
      & $go build ('-ldflags=-X main.version=' + $Ver) -trimpath -o (Join-Path $BuildDir 'forum') ./cmd/forum
    }
    finally {
      Pop-Location
      Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0) { Fail ('go build failed (exit ' + $LASTEXITCODE + ')') }
  }

  # The binary is only as honest as its timestamp: with -SkipBuild a binary from
  # an earlier revision would be published under this release name and 'which
  # code is live' would be a lie again.
  if ($SkipBuild) {
    $bin = Join-Path $BuildDir 'forum'
    if (-not (Test-Path $bin)) { Fail ('no binary at ' + $bin + ' -- run once without -SkipBuild') }
    $binTime = (Get-Item $bin).LastWriteTimeUtc

    # Ask the toolchain which files the binary is actually made of instead of
    # globbing *.go: scratch files and generated probes (zz*_test.go, zz*.go)
    # are newer than any binary and would block every deploy for no reason.
    Set-GoEnv
    $go = Get-GoExe
    Push-Location $ForumDir
    try {
      $dirs = & $go list -deps -f '{{.Dir}}' ./cmd/forum 2>$null
      $srcDirs = @($dirs | Where-Object { $_ -and $_.StartsWith($ForumDir, [StringComparison]::OrdinalIgnoreCase) })
      $files = @()
      # _test.go never ends up in the binary; zz* files are agent scratch
      # (and pinned in .gitignore). Neither may block a deploy.
      foreach ($d in $srcDirs) {
        $files += Get-ChildItem $d -File -Filter *.go -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -notlike '*_test.go' -and $_.Name -notlike 'zz*' }
      }
      $files += Get-Item (Join-Path $ForumDir 'go.mod'), (Join-Path $ForumDir 'go.sum') -ErrorAction SilentlyContinue
      $goVersion = (& $go version)
    }
    finally { Pop-Location }

    $newest = $files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newest -and $newest.LastWriteTimeUtc -gt $binTime) {
      Fail ('the binary is older than ' + $newest.FullName + ' -- rebuild (drop -SkipBuild) before deploying it')
    }
    Info ('binary is current: built ' + $binTime.ToString('yyyy-MM-ddTHH:mm:ssZ') + ' from ' + $srcDirs.Count + ' packages (' + $goVersion + ')')
  }

  $index = Join-Path $WebDir ('dist' + $Sep + 'index.html')
  if (-not (Test-Path $index)) {
    Fail "web/dist/index.html is missing -- there is nothing to deploy. Run 'pnpm --dir web build' first."
  }
  # /healthz reports this string as web_version, so it must match the release.
  $webVersion = $Ver
  if ($BadWebVersion) { $webVersion = $BadWebVersion }
  $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  Set-Content -NoNewline -Encoding ascii -Path (Join-Path $WebDir ('dist' + $Sep + 'VERSION')) -Value ($webVersion + ' ' + $stamp)
  Info ('web/dist/VERSION = ' + $webVersion + ' ' + $stamp)
}

function Step-Pack([string]$Ver) {
  Stage '2/9 pack + sha256'
  $bin = Join-Path $BuildDir 'forum'
  if (-not (Test-Path $bin)) { Fail ('no binary at ' + $bin + ' -- run once without -SkipBuild') }

  $stage = Join-Path $Root ('deploy' + $Sep + '.stage')
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Path (Join-Path $stage 'bin') | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stage 'web') | Out-Null
  Copy-Item $bin (Join-Path $stage ('bin' + $Sep + 'forum'))
  Copy-Item (Join-Path $WebDir 'dist') (Join-Path $stage ('web' + $Sep + 'dist')) -Recurse
  # VERSION at the artifact root is the identity a human reads; web/dist/VERSION
  # is the one /healthz reports as web_version. Same string, two readers.
  Copy-Item (Join-Path $WebDir ('dist' + $Sep + 'VERSION')) (Join-Path $stage 'VERSION')

  New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
  $name = 'forum-' + $Ver + '.tar.gz'
  $artifact = Join-Path $ArtifactDir $name
  if (Test-Path $artifact) { Remove-Item -Force $artifact }
  # bsdtar ships with Windows 10+, so no archiver is added to the toolchain.
  & tar -czf $artifact -C $stage bin web VERSION
  if ($LASTEXITCODE -ne 0) { Fail ('tar failed (exit ' + $LASTEXITCODE + ')') }

  $sha = (Get-FileHash -Algorithm SHA256 $artifact).Hash.ToLower()
  Set-Content -NoNewline -Encoding ascii -Path ($artifact + '.sha256') -Value $sha
  Info ('artifact ' + $artifact)
  Info ('sha256   ' + $sha)
  return @{ Path = $artifact; Sha256 = $sha; Name = $name }
}

function Step-Preflight([string]$Ver, [string]$EnvB64) {
  Stage '3/9 preflight'
  if (-not $EnvB64 -or $EnvB64 -eq (B64 '__MISSING__')) {
    Fail ('/etc/sc2clud/' + $Instance + '.env is missing on the server. Install it once, by hand: see deploy/README.md')
  }
  Info ('ssh ok (' + $Server + ')')
  Info ('/etc/sc2clud/' + $Instance + '.env present')
  $facts = Invoke-Remote 'preflight' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_ENV_B64 = $EnvB64 }
  foreach ($line in ($facts.Out -split "`n")) { if ($line.Trim()) { Info $line } }
}

function Step-Upload($Artifact, [string]$Ver, [string]$EnvB64) {
  Stage '4/9 upload'
  $remotePath = $InstanceDir + '/incoming/' + $Artifact.Name
  $env = @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_ARCHIVE = $remotePath; SC2CLUD_ENV_B64 = $EnvB64 }
  $null = Invoke-Remote 'mkdirs' $env
  Put-File $Artifact.Path $remotePath
  $sha = (Invoke-Remote 'sha256' $env).Out.Trim()
  if ($sha -eq 'SHA256_MISMATCH_OR_MISSING') { Fail ('the uploaded archive is not on the server: ' + $remotePath) }
  if ($sha -ne $Artifact.Sha256) { Fail ('sha256 mismatch after upload: server=' + $sha + ' local=' + $Artifact.Sha256) }
  Info 'sha256 verified on the server'
}

function Step-Install([string]$Ver, [string]$EnvB64) {
  Stage '5/9 install (unpack -> verify -> switch current + unit)'
  $env = @{
    __UNIT__         = B64File (Join-Path $PSScriptRoot ('systemd' + $Sep + 'sc2clud@.service'))
    SC2CLUD_DIR      = $InstanceDir
    SC2CLUD_INSTANCE = $Instance
    SC2CLUD_VERSION  = $Ver
    SC2CLUD_SRC      = 'archive'
    SC2CLUD_ARCHIVE  = $InstanceDir + '/incoming/forum-' + $Ver + '.tar.gz'
    SC2CLUD_ENV_B64  = $EnvB64
  }
  $out = (Invoke-Remote 'install' $env).Out
  $prev = ''
  foreach ($line in ($out -split "`n")) {
    if (-not $line.Trim()) { continue }
    Info $line
    if ($line.StartsWith('previous: ')) { $prev = $line.Substring(10).Trim() }
  }
  if ($prev -eq '(none)') { $prev = '' }
  return $prev
}

function Step-Backup([string]$Ver, [string]$EnvB64) {
  Stage '6/9 backup database (before anything writes to it)'
  if ($SkipDbBackup) { Warn 'SKIPPED (-SkipDbBackup) -- drills only'; return $null }
  $env = @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_VERSION = $Ver; SC2CLUD_ENV_B64 = $EnvB64 }
  $out = (Invoke-Remote 'backup' $env).Out
  $first = ''
  foreach ($line in ($out -split "`n")) {
    if (-not $line.Trim()) { continue }
    Info $line
    if (-not $first) { $first = $line }
  }
  return $first
}

function Step-MigrateAndStart([string]$Ver, [string]$EnvB64) {
  Stage '7/9 stop -> migrate -> start'
  Info ('systemctl stop ' + $UnitName)
  $stop = Invoke-Remote 'service' (@{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_ACTION = 'stop'; SC2CLUD_ENV_B64 = $EnvB64 }) -AllowFail
  if ($stop.Out.Trim()) { Info $stop.Out.Trim() }

  # migrate runs the migration files embedded in the binary, then prints the
  # version the database landed on. A mismatch exits non-zero and the service is
  # never started against a schema the binary does not expect.
  $mig = Invoke-Remote 'migrate' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_VERSION = $Ver; SC2CLUD_ENV_B64 = $EnvB64 }
  foreach ($line in ($mig.Out -split "`n")) { if ($line.Trim()) { Info $line } }

  Info ('systemctl start ' + $UnitName)
  $start = Invoke-Remote 'service' (@{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_ACTION = 'start'; SC2CLUD_ENV_B64 = $EnvB64 })
  if ($start.Out.Trim()) { Info $start.Out.Trim() }
  return $mig.Out
}

function Step-Health([string]$Ver, [string]$EnvB64) {
  Stage '8/9 health'
  $facts = @{}
  $res = Invoke-Remote 'health' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_VERSION = $Ver; SC2CLUD_HEALTH_PATH = $HealthPath; SC2CLUD_ENV_B64 = $EnvB64 } -AllowFail
  foreach ($line in ($res.Out -split "`n")) {
    $t = $line.TrimEnd()
    if (-not $t) { continue }
    Info $t
    $i = $t.IndexOf('=')
    if ($i -gt 0) { $facts[$t.Substring(0, $i)] = $t.Substring($i + 1) }
  }
  if ($res.Code -ne 0) { Fail ('the health probe itself failed (exit ' + $res.Code + ')') }
  if ($facts['unit'] -ne 'active') { Fail ('the service is not active after start: ' + $facts['unit']) }
  if ($facts['health_code'] -ne '200') { Fail ('health probe returned HTTP ' + $facts['health_code'] + ' (probed ' + $HealthPath + ')') }

  $health = $null
  try { $health = $facts['health_body'] | ConvertFrom-Json } catch { Fail ('health body is not JSON: ' + $facts['health_body']) }
  if ($health.version -ne $Ver) { Fail ("running binary version '" + $health.version + "' != deployed '" + $Ver + "'") }
  $webv = [string]$health.web_version
  if ($webv -and -not $webv.StartsWith($Ver)) {
    Fail ("running web_version '" + $webv + "' != deployed '" + $Ver + "' -- the frontend on disk is not this build")
  }
  Info ('version match: binary=' + $health.version + ' web=' + $webv)
  if ($facts['home_code'] -ne '200') { Fail ('the front page returned HTTP ' + $facts['home_code']) }
  if ($facts['asset'] -and $facts['asset'] -ne '(none)' -and $facts['asset_code'] -ne '200') {
    Fail ('first-screen asset /' + $facts['asset'] + ' returned HTTP ' + $facts['asset_code'])
  }

  # Public path through nginx. Informational: DNS and TLS are not this script's job.
  $pub = Invoke-Curl $PublicUrl
  Info ('public ' + $PublicUrl + ' -> ' + $pub.Code + ' (through nginx)')
  return $facts
}

function Invoke-Rollback([string]$Prev, [string]$FailedVer, [string]$EnvB64) {
  $shown = $Prev
  if (-not $shown) { $shown = 'nothing (no previous release)' }
  Stage ('ROLLBACK current -> ' + $shown)
  if (-not $Prev) {
    Warn 'No previous release exists: this was the first deploy.'
    Warn 'The failed release stays on disk; the service state is left as it is.'
    return $false
  }
  $out = (Invoke-Remote 'rollback' @{ SC2CLUD_DIR = $InstanceDir; SC2CLUD_INSTANCE = $Instance; SC2CLUD_TARGET = $Prev; SC2CLUD_ENV_B64 = $EnvB64 }).Out
  foreach ($line in ($out -split "`n")) { if ($line.Trim()) { Info $line } }

  $r = @{ Code = '000'; Body = '' }
  for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Milliseconds 500
    $r = Invoke-Curl ('http://' + $LocalAddr + '/healthz')
    if ($r.Code -eq '200') { break }
  }
  Info ('after rollback: GET /healthz -> ' + $r.Code + ' ' + $r.Body)
  if ($r.Code -ne '200') { Fail ('rollback did not come up either -- the site is down, fix it by hand (systemctl status ' + $UnitName + ')') }

  Write-Host ''
  Write-Host ('  ROLLED BACK: ' + $FailedVer + ' -> ' + $Prev) -ForegroundColor Yellow
  Write-Host '  The DATABASE was not rolled back: migrations are forward-only here.' -ForegroundColor Yellow
  Write-Host ('  Pre-deploy dump (if any) is under ' + $InstanceDir + '/backups/.') -ForegroundColor Yellow
  Write-Host '  Restoring it is a human decision -- it also discards everything written' -ForegroundColor Yellow
  Write-Host '  since the dump, not just the schema change.' -ForegroundColor Yellow
  return $true
}

# ---------------------------------------------------------------- main
if (-not (Test-Path $SshKey)) { Fail ('SSH key not found: ' + $SshKey) }

$sw = [Diagnostics.Stopwatch]::StartNew()
Write-Host ''
Write-Host ('SC2clud deploy  instance=' + $Instance + '  dir=' + $InstanceDir + '  addr=' + $LocalAddr)

if (-not $Version) {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    Push-Location $Root
    try {
      $sha = & git rev-parse --short HEAD 2>$null
      if ($sha) { $Version = ([string]$sha).Trim() }
    }
    finally { Pop-Location }
  }
  if (-not $Version) { Fail 'cannot determine version: no git, no -Version. Pass -Version <name>.' }
}

$EnvB64 = Read-RemoteFile ('/etc/sc2clud/' + $Instance + '.env') $Instance
$dump = $null
$rolledBack = $false
$prev = ''
$facts = @{}
try {
  Step-Build $Version
  $artifact = Step-Pack $Version
  Step-Preflight $Version $EnvB64
  Step-Upload $artifact $Version $EnvB64
  $prev = Step-Install $Version $EnvB64
  $dump = Step-Backup $Version $EnvB64
  $null = Step-MigrateAndStart $Version $EnvB64
  $facts = Step-Health $Version $EnvB64

  Write-Host ''
  Write-Host ('  DEPLOYED ' + $Version + ' on ' + $Instance) -ForegroundColor Green
  Write-Host ('  dir      ' + $InstanceDir + '/current -> releases/' + $Version)
  Write-Host ('  health   ' + $facts['health_body'])
  if ($dump) { Write-Host ('  backup   ' + $dump) }
  Write-Host ('  elapsed  ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's')
  exit 0
}
catch {
  Write-Host ''
  Write-Host ('  DEPLOY FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  if (-not $NoRollback) {
    $cur = Get-RemoteLink ($InstanceDir + '/current') $Instance
    if ($cur -and $cur -ne ('releases/' + $Version)) {
      $rolledBack = Invoke-Rollback $cur $Version $EnvB64
    }
    elseif ($prev -and $prev -ne ('releases/' + $Version)) {
      $rolledBack = Invoke-Rollback $prev $Version $EnvB64
    }
    else {
      Warn 'Nothing to roll back to (failure happened before the switch, or this is the first deploy).'
    }
  }
  Write-Host ''
  Write-Host ('  elapsed ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's')
  if ($rolledBack) { exit 3 } else { exit 1 }
}
