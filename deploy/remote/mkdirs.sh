#!/usr/bin/env bash
# Create the instance skeleton. Idempotent, and safe to run before the first
# release exists.
. /tmp/sc2clud-lib.sh
mkdir -p "$SC2CLUD_DIR/releases" "$SC2CLUD_DIR/data" "$SC2CLUD_DIR/backups" "$SC2CLUD_DIR/incoming" "$SC2CLUD_DIR/artifacts"
chmod 700 "$SC2CLUD_DIR/backups"
echo "dirs: $SC2CLUD_DIR/{releases,data,backups,incoming,artifacts}"
