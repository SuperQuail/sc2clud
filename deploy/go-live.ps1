# ============================================================
# go-live.ps1 -- switch the production site (/) from the maintenance
# placeholder to the new Go instance. One command, reversible in ~30s.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/go-live.ps1 -Action check
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/go-live.ps1 -Action cutover
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/go-live.ps1 -Action rollback
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 file as
# ANSI, so non-ASCII here would corrupt the bash body instead of just the text.
# ============================================================
param(
  [ValidateSet('check','cutover','rollback')] [string]$Action = 'check'
)
$ErrorActionPreference = 'Stop'
$Instance = 'prod'
. (Join-Path $PSScriptRoot 'lib.ps1')

$PREFLIGHT = @'
set -e
echo '--- prod.env ---'
test -f /etc/sc2clud/prod.env || { echo 'MISSING /etc/sc2clud/prod.env'; exit 1; }
N=$(grep -cE '^FORUM_' /etc/sc2clud/prod.env || true)
echo "  keys=$N (expect 22)"
[ "$N" -ge 20 ] || { echo '  too few keys -- see deploy/README.md:54-60'; exit 1; }
grep -q '^FORUM_KV__ADDR=' /etc/sc2clud/prod.env || { echo '  FORUM_KV__ADDR missing (wrong key name => Redis silently unused)'; exit 1; }
grep -q '^FORUM_SITE__BASE_URL=https://' /etc/sc2clud/prod.env || { echo '  base_url must be https for prod'; exit 1; }
echo '--- release ---'
test -x /srv/sc2clud-prod/current/bin/forum || { echo 'MISSING /srv/sc2clud-prod/current/bin/forum'; exit 1; }
echo "  version=$(cat /srv/sc2clud-prod/current/VERSION 2>/dev/null || echo unknown)"
echo '--- database ---'
B=$(su postgres -c "psql -d forum -tAc 'select count(*) from boards'" | tr -d ' ')
S=$(su postgres -c "psql -d forum -tAc 'select count(*) from topic_search'" | tr -d ' ')
echo "  boards=$B topic_search=$S"
[ "$B" -gt 0 ] || { echo '  no boards in forum -- live site would be empty'; exit 1; }
echo '--- images ---'
I=$(find /srv/sc2clud-prod/data/images -type f | wc -l)
echo "  image files=$I"
[ "$I" -gt 0 ] || { echo '  no image bytes -- avatars would 404'; exit 1; }
echo '--- ports and units ---'
echo -n '  8080 holder: '; ss -ltnp 2>/dev/null | grep ':8080' | sed 's/.*users://' | head -1 || echo none
echo -n '  placeholder: '; systemctl is-active sc2clud-placeholder.service || true
echo -n '  sc2clud@prod: '; systemctl is-active sc2clud@prod.service || true
echo -n '  addr in env: '; grep '^FORUM_HTTP__ADDR' /etc/sc2clud/prod.env
echo '--- nginx ---'
nginx -t 2>&1 | tail -1
echo 'PREFLIGHT OK'
'@

$CUTOVER = @'
set -e
# 1) free port 8080: the placeholder owns it right now.
systemctl stop sc2clud-placeholder.service
systemctl disable sc2clud-placeholder.service >/dev/null 2>&1 || true
# 2) point prod at 8080 (the rehearsal used 8081 so it would not fight the placeholder).
sed -i 's|^FORUM_HTTP__ADDR=.*|FORUM_HTTP__ADDR=127.0.0.1:8080|' /etc/sc2clud/prod.env
# 3) restart the real instance and wait for it.
systemctl restart sc2clud@prod.service
for i in $(seq 1 30); do
  C=$(curl -s -o /tmp/vz -w '%{http_code}' -H 'Host: www.xn--xpra07ba.fun' http://127.0.0.1:8080/healthz || true)
  [ "$C" = "200" ] && break
  sleep 1
done
echo '--- after cutover ---'
echo -n '  healthz: '; curl -s -H 'Host: www.xn--xpra07ba.fun' http://127.0.0.1:8080/healthz; echo
echo -n '  / : '; curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: www.xn--xpra07ba.fun' http://127.0.0.1:8080/
echo -n '  boards: '; curl -s -H 'Host: www.xn--xpra07ba.fun' http://127.0.0.1:8080/api/v1/boards | head -c 90; echo
echo -n '  unknown api must be 404 JSON: '; curl -s -w ' [%{http_code}]\n' -H 'Host: www.xn--xpra07ba.fun' http://127.0.0.1:8080/api/v1/nope | head -c 120
echo -n '  8080 holder: '; ss -ltnp 2>/dev/null | grep ':8080' | sed 's/.*users://' | head -1
echo -n '  placeholder: '; systemctl is-active sc2clud-placeholder.service || true
echo 'CUTOVER DONE'
'@

$ROLLBACK = @'
set -e
systemctl stop sc2clud@prod.service || true
systemctl enable sc2clud-placeholder.service >/dev/null 2>&1 || true
systemctl start sc2clud-placeholder.service
sleep 2
echo -n '  / now: '; curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: www.xn--xpra07ba.fun' http://127.0.0.1:8080/
echo -n '  placeholder: '; systemctl is-active sc2clud-placeholder.service || true
echo 'ROLLBACK DONE'
'@

$body = switch ($Action) { 'check' { $PREFLIGHT } 'cutover' { $PREFLIGHT + $NL + $CUTOVER } 'rollback' { $ROLLBACK } }
Stage ('go-live ' + $Action)
$r = Invoke-Ssh $body
Write-Host $r.Out
if ($r.Code -ne 0) { Fail ('go-live ' + $Action + ' failed (exit ' + $r.Code + ')') }
Info ('go-live ' + $Action + ' OK')