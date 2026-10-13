#!/usr/bin/env bash
# pg_dump -Fc the instance database into <dir>/backups/. Runs BEFORE the service
# is stopped and before any migration, so the dump is a pre-deploy snapshot.
# A dump that is missing or tiny is treated as a failed backup, not a warning:
# a rollback without a dump is not a rollback.
. /tmp/sc2clud-lib.sh
load_env

stamp=$(date -u +%Y%m%d-%H%M%S)
out="$SC2CLUD_DIR/backups/pre-deploy-${SC2CLUD_VERSION}-${stamp}.dump"
umask 077
pg_dump --no-psqlrc -Fc -f "$out"
chmod 600 "$out"

size=$(stat -c %s "$out")
echo "backup: $out ($size bytes)"
[ "$size" -gt 0 ] || { echo "backup is empty -- refusing to continue" >&2; exit 1; }
printf 'restore: pg_restore --clean --if-exists -d <dsn> %s\n' "$out"
