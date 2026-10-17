#!/usr/bin/env bash
# Print the sha256 of the uploaded artifact. Prints a sentinel instead of failing
# so the caller can report 'the upload did not arrive' in its own words.
. /tmp/sc2clud-lib.sh
if [ -f "$SC2CLUD_ARCHIVE" ]; then
  sha256sum "$SC2CLUD_ARCHIVE" | awk '{print $1}'
else
  echo "SHA256_MISMATCH_OR_MISSING"
fi
