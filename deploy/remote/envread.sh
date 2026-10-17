#!/usr/bin/env bash
# Print one file from the box, base64-encoded, so the caller can read secrets
# without a second transport. Missing file prints the __MISSING__ sentinel
# instead of failing, because 'not installed yet' is a normal first-run state.
. /tmp/sc2clud-lib.sh
target="${SC2CLUD_READ:?SC2CLUD_READ is required}"
if [ -f "$target" ]; then
  base64 -w0 "$target"
  echo
else
  echo "__MISSING__"
fi
