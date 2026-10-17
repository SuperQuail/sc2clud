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
# No --no-psqlrc: that option belongs to psql (-X). pg_dump never reads psqlrc, and postgresql 17's
# pg_dump rejects the flag outright -- which is how the first dev deploy died at step 6.
# 2026-10-13. The install step had already refused earlier for a different reason; both failures
# happened BEFORE the service was stopped, which is the point of the ordering.
pg_dump -Fc -f "$out"
chmod 600 "$out"

size=$(stat -c %s "$out")
echo "backup: $out ($size bytes)"
[ "$size" -gt 0 ] || { echo "backup is empty -- refusing to continue" >&2; exit 1; }
# '-Fc' dumps start with the magic 'PGDMP'. Size alone does not prove the dump is restorable,
# and a rollback without a restorable dump is not a rollback.
magic=$(head -c 5 "$out" | tr -d '\0')
[ "$magic" = 'PGDMP' ] || { echo "backup is not a -Fc archive (magic='$magic') -- refusing to continue" >&2; exit 1; }
printf 'restore: pg_restore --clean --if-exists -d <dsn> %s\n' "$out"
