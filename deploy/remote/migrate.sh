#!/usr/bin/env bash
# Run the migrations embedded in the release binary, then print the version the
# database actually landed on. Non-zero exit = the caller must not start the
# service.
. /tmp/sc2clud-lib.sh
load_env

bin="$SC2CLUD_DIR/current/bin/forum"
[ -x "$bin" ] || { echo "no runnable binary at $bin" >&2; exit 1; }

# migrate prints 'migrate: ok, version=N' and exits non-zero when the database
# does not end up on the binary's own latest version.
"$bin" migrate

printf 'schema_migrations: '
psql --no-psqlrc -Atc 'select version from schema_migrations'
