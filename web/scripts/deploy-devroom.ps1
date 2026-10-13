# Refresh the DevRoom design reference on the dev environment.
# Usage (from repo root):  powershell -NoProfile -ExecutionPolicy Bypass -File web\scripts\deploy-devroom.ps1
# Entry (unchanged, same as the legacy build it replaced):  http://191.40.41.97/dev/devroom/
#
# WHERE IT GOES: /srv/sc2clud-dev/dist/devroom/ -- the dev instance's own dist, which ALREADY had a
# DevRoom (art/, assets/, index.html, isolate.html, preview.html). We replace that directory in place
# instead of inventing a new path: same URL, same entry file name, nothing new to remember.
#
# WHY NOT A SEPARATE PORT-80 PATH (tried, reverted):
#   /dev/ is not a directory prefix, it is a whole isolated environment -- a second app instance
#   (sc2clud-dev, 127.0.0.1:8081) with its own data dir and its own rate-limit zones, promoted to prod
#   by deploy/promote.sh. A parallel path would be a third, undefined environment. Also the legacy
#   DevRoom entry already existed; making a new one was redundant.
#
# WHY NO CACHE HEADER WORK IS NEEDED: the dev app serves this entry with `Cache-Control: no-store`,
#   so a refresh always picks up a new build. (An earlier version of this script timestamped the entry
#   file name to dodge caching -- that hack is gone, the header already handles it.)
#
# Why not run vite dev on the server: the server has no node, and its firewall only opens 22/80/443/888.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
# and non-ASCII bytes here corrupt the script instead of just garbling a message.
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$key   = Join-Path $root 'secrets\ssh\id_ed25519_deploy'
$srv   = 'root@191.40.41.97'
$dest  = '/srv/sc2clud-dev/dist/devroom'
$url   = 'http://191.40.41.97/dev/devroom/'

if (-not (Test-Path $key)) { throw "SSH key not found: $key" }

Write-Host '[1/3] building preview bundle ...'
Push-Location (Join-Path $root 'web')
try { & npx vite build --config vite.preview.config.ts } finally { Pop-Location }

$out = Join-Path $root 'web\preview-dist'
if (-not (Test-Path (Join-Path $out 'devroom.html'))) { throw 'build produced no devroom.html' }
# the dev entry file is index.html (legacy name); keep both so either URL works
Copy-Item (Join-Path $out 'devroom.html') (Join-Path $out 'index.html') -Force

Write-Host '[2/3] uploading ...'
& ssh -i $key -o BatchMode=yes $srv "mkdir -p $dest && rm -rf ${dest}/*"
& scp -i $key -o BatchMode=yes -r (Join-Path $out '*') "${srv}:$dest/"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

Write-Host '[3/3] verifying ...'
$code = & curl.exe -s -o NUL -w '%{http_code}' $url
if ($code -ne '200') { throw "$url did not return 200 (got $code)" }

# the served entry must point at the bundle we just built, otherwise we served something stale
$html   = & curl.exe -s $url
$want   = (Select-String -Path (Join-Path $out 'devroom.html') -Pattern 'assets/devroom-[A-Za-z0-9_-]+\.js' -AllMatches).Matches[0].Value
$served = ([regex]::Match($html, 'assets/devroom-[A-Za-z0-9_-]+\.js')).Value
if ($served -ne $want) { throw "served entry points at $served, expected $want" }

Write-Host ''
Write-Host "  OPEN THIS:  $url"
Write-Host "  bundle:     $want"
Write-Host ''