# Sync the DevRoom preview build into the DEV environment so collaborators can browse it.
# Usage (from repo root):  powershell -NoProfile -ExecutionPolicy Bypass -File web\scripts\deploy-devroom.ps1
# Result:                  http://191.40.41.97/dev/static/devroom/devroom.html
#
# WHY IT GOES UNDER /dev/static/ AND NOT ITS OWN PATH:
#   /dev/ is not a directory prefix, it is a whole isolated environment -- a second app instance
#   (sc2clud-dev, 127.0.0.1:8081) with its own data dir and its own rate-limit zones, promoted to prod
#   by deploy/promote.sh. Serving the DevRoom from a parallel path on port 80 would create a third,
#   undefined environment: outside the dev rate limits and outside the promote story.
#   It is just static assets of the dev environment, so it lives in the dev environment's static dir
#   (location /dev/static/ already exists -> alias /srv/sc2clud-dev/static/, burst=96, access_log off).
#   No nginx edit, no reload.
#
# Why not run vite dev on the server: the server has no node, and its firewall only opens 22/80/443/888.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
# and non-ASCII bytes here corrupt the script instead of just garbling a message.
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$key   = Join-Path $root 'secrets\ssh\id_ed25519_deploy'
$srv   = 'root@191.40.41.97'
$dest  = '/srv/sc2clud-dev/static/devroom'
$url   = 'http://191.40.41.97/dev/static/devroom/devroom.html'

if (-not (Test-Path $key)) { throw "SSH key not found: $key" }

Write-Host '[1/3] building preview bundle ...'
Push-Location (Join-Path $root 'web')
try { & npx vite build --config vite.preview.config.ts } finally { Pop-Location }

$out = Join-Path $root 'web\preview-dist'
if (-not (Test-Path (Join-Path $out 'devroom.html'))) { throw 'build produced no devroom.html' }

Write-Host '[2/3] uploading ...'
& ssh -i $key -o BatchMode=yes $srv "mkdir -p $dest && rm -rf ${dest}/*"
& scp -i $key -o BatchMode=yes -r (Join-Path $out '*') "${srv}:$dest/"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

Write-Host '[3/3] verifying ...'
$code = & curl.exe -s -o NUL -w '%{http_code}' $url
Write-Host "  $url -> $code"
if ($code -ne '200') { throw "site did not return 200 (got $code)" }
Write-Host '  done. refresh the browser to see the latest build.'