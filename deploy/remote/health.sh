#!/usr/bin/env bash
# Probe the instance from inside the box. Always exits 0 and prints the facts:
# the caller decides what counts as a failure, so a failed probe is never
# swallowed into a green log line.
. /tmp/sc2clud-lib.sh
load_env

addr="${FORUM_HTTP__ADDR:?FORUM_HTTP__ADDR is not set in the env file}"
path="${SC2CLUD_HEALTH_PATH:-/healthz}"
unit=$(unit_name)

printf 'unit=%s\n' "$(systemctl is-active "$unit" 2>/dev/null || echo inactive)"
printf 'addr=%s\n' "$addr"
printf 'version=%s\n' "$(cat "$SC2CLUD_DIR/current/VERSION" 2>/dev/null || echo unknown)"
printf 'web_version=%s\n' "$(cat "$SC2CLUD_DIR/current/web/dist/VERSION" 2>/dev/null || echo unknown)"

printf 'health_code='
curl -s -o /tmp/sc2clud-health-body -m 10 -w '%{http_code}\n' "http://$addr$path" || echo 000
printf 'health_body='
cat /tmp/sc2clud-health-body 2>/dev/null || true
printf '\n'

printf 'home_code='
curl -s -o /tmp/sc2clud-home-body -m 10 -w '%{http_code}\n' "http://$addr/" || echo 000
printf 'home_bytes=%s\n' "$(wc -c < /tmp/sc2clud-home-body 2>/dev/null || echo 0)"
asset=$(grep -oE '(src|href)="[.]?/?(assets/[A-Za-z0-9._-]+)"' /tmp/sc2clud-home-body 2>/dev/null | head -1 | sed -E 's/.*(assets\/[A-Za-z0-9._-]+).*/\1/')
if [ -n "$asset" ]; then
  printf 'asset=%s\n' "$asset"
  printf 'asset_code='
  curl -s -o /dev/null -m 10 -w '%{http_code}\n' "http://$addr/$asset" || echo 000
else
  printf 'asset=(none)\n'
  printf 'asset_code=0\n'
fi

printf 'schema_migrations='
psql --no-psqlrc -Atc 'select version from schema_migrations' 2>/dev/null || echo none
printf '\n'

printf 'disk_free_mb=%s\n' "$(df -Pk "$SC2CLUD_DIR" | awk 'NR==2{print int($4/1024)}')"
