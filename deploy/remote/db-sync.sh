#!/usr/bin/env bash
# COPY THE PRODUCTION DATABASE INTO DEV. One direction only.
# This script refuses to run against prod, so there is no code path in this
# repository that can write production data from a snapshot.
. /tmp/sc2clud-lib.sh

if [ "$SC2CLUD_INSTANCE" = "prod" ]; then
  echo "sync is dev-only: refusing to restore into the production instance" >&2
  exit 1
fi

dump="${SC2CLUD_DUMP:?SC2CLUD_DUMP is required (produced by SC2CLUD_SRC_INSTANCE=prod backup.sh)}"
[ -f "$dump" ] || { echo "snapshot not found: $dump" >&2; exit 1; }

load_env
unit=$(unit_name)

systemctl stop "$unit" || true
set +e
pg_restore --no-psqlrc --clean --if-exists --no-owner -d "$PGDATABASE" "$dump"
rc=$?
set -e
systemctl start "$unit"
sleep 1
systemctl is-active "$unit" || true
exit $rc
