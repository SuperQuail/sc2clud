#!/usr/bin/env bash
# Repoint <dir>/current at a named release and restart the instance.
# Used both by 'deploy.ps1 rollback' and by the automatic rollback after a
# failed health check.
. /tmp/sc2clud-lib.sh
load_env

target="${SC2CLUD_TARGET:?SC2CLUD_TARGET is required}"
[ -n "$target" ] || { echo "SC2CLUD_TARGET is empty" >&2; exit 1; }

# Accept a bare release name, or the old symlink target ('releases/<v>').
case "$target" in
  /*)        link="$target" ;;
  releases/*) link="$SC2CLUD_DIR/$target" ;;
  *)         link="$SC2CLUD_DIR/releases/$target" ;;
esac

if [ ! -x "$link/bin/forum" ]; then
  echo "rollback target is not a usable release: $link" >&2
  ls -1dt "$SC2CLUD_DIR"/releases/*/ >&2 || true
  exit 1
fi

cd "$SC2CLUD_DIR"
ln -sfn "$link" current.new
mv -Tf current.new current
ls -l current

unit=$(unit_name)
systemctl restart "$unit"
sleep 1
systemctl is-active "$unit" || true
