#!/usr/bin/env bash
# Facts the deploy needs before it writes anything. Exit non-zero to abort.
. /tmp/sc2clud-lib.sh
load_env

echo "addr      : ${FORUM_HTTP__ADDR:-(unset)}"
echo "env       : ${FORUM_ENV:-(unset)}"
echo "database  : ${PGDATABASE}@${PGHOST}"
echo "db user   : ${PGUSER}"

# Two instances on one box: if this port is held by something that is not our
# unit, the new release will fail to bind and the deploy would look like a code
# failure. Say it here instead.
addr="${FORUM_HTTP__ADDR:-}"
port="${addr##*:}"
unit=$(unit_name)
holder=$(ss -lntp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $0}' || true)
if [ -n "$holder" ]; then
  if echo "$holder" | grep -q "forum"; then
    echo "port $port : held by a running forum process (expected on a redeploy)"
  else
    echo "port $port : held by something else -- refusing to continue" >&2
    echo "$holder" >&2
    exit 1
  fi
else
  echo "port $port : free"
fi

latest=$(ls -1d "$SC2CLUD_DIR"/releases/*/ 2>/dev/null | tail -1 || true)
if [ -n "$latest" ]; then
  echo "last release : $(basename "$latest")"
fi
echo "current      : $(readlink "$SC2CLUD_DIR/current" 2>/dev/null || echo none)"
echo "disk free    : $(df -Pk "$SC2CLUD_DIR" | awk 'NR==2{print int($4/1024)}') MB"
echo "unit files   : $(ls -1 /etc/systemd/system/sc2clud@.service 2>/dev/null || echo none)"
