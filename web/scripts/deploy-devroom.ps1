# Sync the DevRoom preview build to the server so collaborators can browse it in a browser.
# Usage (from repo root):  powershell -NoProfile -ExecutionPolicy Bypass -File web\scripts\deploy-devroom.ps1
# Result:                  http://191.40.41.97/devroom/
#
# Why not run vite dev on the server: the server has no node, and its firewall only opens 22/80/443/888.
# So: build locally -> scp -> nginx serves it as static files (same approach as the legacy site's dist/devroom).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
# and non-ASCII bytes here corrupt the script instead of just garbling a message.
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$key   = Join-Path $root 'secrets\ssh\id_ed25519_deploy'
$srv   = 'root@191.40.41.97'
$dest  = '/srv/sc2clud-preview/'

if (-not (Test-Path $key)) { throw "SSH key not found: $key" }

Write-Host '[1/3] building preview bundle ...'
Push-Location (Join-Path $root 'web')
try { & npx vite build --config vite.preview.config.ts } finally { Pop-Location }

$out = Join-Path $root 'web\preview-dist'
if (-not (Test-Path (Join-Path $out 'devroom.html'))) { throw 'build produced no devroom.html' }

# nginx uses index.html as the directory index; keep devroom.html too (accessible by name).
Copy-Item (Join-Path $out 'devroom.html') (Join-Path $out 'index.html') -Force

Write-Host '[2/3] uploading ...'
& ssh -i $key -o BatchMode=yes $srv "mkdir -p $dest && rm -rf ${dest}*"
& scp -i $key -o BatchMode=yes -r (Join-Path $out '*') "${srv}:$dest"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

Write-Host '[3/3] verifying ...'
$code = & curl.exe -s -o NUL -w '%{http_code}' 'http://191.40.41.97/devroom/'
Write-Host "  http://191.40.41.97/devroom/ -> $code"
if ($code -ne '200') { throw "site did not return 200 (got $code)" }
Write-Host '  done. refresh the browser to see the latest build.'