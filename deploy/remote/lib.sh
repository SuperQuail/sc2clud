#!/usr/bin/env bash
# SC2clud remote deploy library. deploy.ps1 installs it to /tmp/sc2clud-lib.sh
# right before every remote call (the bytes travel base64-encoded, so there is no
# scp dependency and no quoting layer), and each remote script sources it first.
#
# Context arrives through the environment, never through argv:
#   SC2CLUD_ENV_B64      base64 of /etc/sc2clud/<instance>.env  (secrets)
#   SC2CLUD_DIR          release root, e.g. /srv/sc2clud-prod
#   SC2CLUD_INSTANCE     prod | dev
#   SC2CLUD_VERSION      release name
#   SC2CLUD_SRC          archive | staged       (install.sh)
#   SC2CLUD_ARCHIVE      path to forum-<v>.tar.gz (install.sh)
#   SC2CLUD_TARGET       rollback target        (rollback.sh)
#   SC2CLUD_ACTION       start|stop|restart     (service.sh)
#   SC2CLUD_HEALTH_PATH  probe path, default /healthz (health.sh)
#
# The env file travels base64-encoded so a secret-heavy file survives
# PowerShell -> ssh -> bash byte-for-byte. Nothing reads a secret from argv and
# nothing prints one.

set -euo pipefail

: "${SC2CLUD_DIR:?SC2CLUD_DIR is required}"
: "${SC2CLUD_INSTANCE:?SC2CLUD_INSTANCE is required}"

# sshd's PATH is not this shell's PATH; be explicit about where the tools are.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Load the instance env file into the shell AND into PG* so psql/pg_dump need no
# --dbname string and no password on the command line.
load_env() {
  if [ -n "${SC2CLUD_ENV_B64:-}" ]; then
    envfile=$(mktemp)
    chmod 600 "$envfile"
    printf '%s' "$SC2CLUD_ENV_B64" | base64 -d > "$envfile"
  else
    envfile="/etc/sc2clud/${SC2CLUD_INSTANCE}.env"
  fi

  set -a
  # shellcheck disable=SC1090
  . "$envfile"
  set +a

  # postgres://user:pass@host:port/dbname?params -> PGUSER/PGPASSWORD/PGHOST/PGDATABASE
  rest="${FORUM_DB__DSN#*://}"
  creds="${rest%%@*}"
  hostpart="${rest#*@}"
  export PGUSER="${creds%%:*}"
  export PGPASSWORD="${creds#*:}"
  export PGHOST="${hostpart%%/*}"
  db="${hostpart##*/}"
  export PGDATABASE="${db%%\?*}"
}

unit_name() { printf 'sc2clud@%s' "$SC2CLUD_INSTANCE"; }
