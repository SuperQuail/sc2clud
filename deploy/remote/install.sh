#!/usr/bin/env bash
# Unpack, verify and publish ONE release, then install the unit file.
# Publishing = atomically repointing <dir>/current. Nothing is stopped here:
# this script must never leave the instance without a working current.
# Prints 'previous: <target>' so the caller knows what to roll back to.
. /tmp/sc2clud-lib.sh

version="${SC2CLUD_VERSION:?SC2CLUD_VERSION is required}"
name="forum-${version}.tar.gz"
src="${SC2CLUD_SRC:-archive}"
archive="${SC2CLUD_ARCHIVE:-$SC2CLUD_DIR/incoming/$name}"

mkdir -p "$SC2CLUD_DIR/releases" "$SC2CLUD_DIR/data" "$SC2CLUD_DIR/backups" "$SC2CLUD_DIR/incoming" "$SC2CLUD_DIR/artifacts"

# Releases are immutable by contract. Overwriting one is how 'which code is live'
# became unanswerable on the old site.
if [ -e "$SC2CLUD_DIR/releases/$version" ]; then
  echo "release $version already exists on the server -- pick another version" >&2
  exit 1
fi

staging="$SC2CLUD_DIR/releases/.staging-$version"
rm -rf "$staging"
mkdir -p "$staging"

if [ "$src" = "archive" ]; then
  [ -f "$archive" ] || { echo "artifact not found: $archive" >&2; exit 1; }
  # Absolute paths and .. are the two ways a tarball writes outside its release
  # directory.
  bad=$(tar -tzf "$archive" | grep -E '^/|(^|/)[.][.](/|$)' || true)
  if [ -n "$bad" ]; then
    echo "artifact contains unsafe paths:" >&2
    echo "$bad" >&2
    exit 1
  fi
  tar -xzf "$archive" -C "$staging"
  mv -f "$archive" "$SC2CLUD_DIR/artifacts/$name"
fi

# The artifact is packaged on Windows, which has no unix permission bits: tar records 0666,
# so the binary arrives non-executable even though it is a perfectly good ELF. The mode is a
# property of the packaging machine, not a signal about this artifact -- so set it here, and
# let the checks below be about the binary itself (non-empty + actually an ELF).
# (2026-10-13: this is what 'bin/forum missing or not executable' meant on the first deploy.
#  The install step refused instead of switching current -- which is why it was safe to fix.)
if [ -f "$staging/bin/forum" ]; then chmod 0755 "$staging/bin/forum"; fi

test -s "$staging/bin/forum"           || { echo 'bin/forum missing or empty' >&2; exit 1; }
# 7f 45 4c 46 = \x7fELF
elf=$(head -c 4 "$staging/bin/forum" | od -An -tx1 | tr -d ' \n')
[ "$elf" = '7f454c46' ]               || { echo "bin/forum is not an ELF binary (magic=$elf)" >&2; exit 1; }
test -x "$staging/bin/forum"           || { echo 'chmod failed on bin/forum' >&2; exit 1; }
test -f "$staging/web/dist/index.html" || { echo 'web/dist/index.html missing' >&2; exit 1; }
test -f "$staging/VERSION"             || { echo 'VERSION missing' >&2; exit 1; }

echo "VERSION   : $(cat "$staging/VERSION")"
echo "bin/forum : $(stat -c %s "$staging/bin/forum") bytes"
echo "web/dist  : $(find "$staging/web/dist" -type f | wc -l) files"

mv -T "$staging" "$SC2CLUD_DIR/releases/$version"
test -x "$SC2CLUD_DIR/releases/$version/bin/forum" || { echo 'release rename failed' >&2; exit 1; }

previous=$(readlink "$SC2CLUD_DIR/current" 2>/dev/null || true)
printf 'previous: %s\n' "${previous:-(none)}"
printf '%s\n' "$version" > "$SC2CLUD_DIR/incoming/last-built-version"

cd "$SC2CLUD_DIR"
ln -sfn "releases/$version" current.new
mv -Tf current.new current
ls -l current

# Keep the newest 3 releases; never delete the one a rollback might need.
ls -1dt releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf

# Publish the unit from the repo so the server cannot drift from it. A drop-in
# overriding ExecStart is exactly what bit the old site.
if [ -s /tmp/sc2clud-unit.service ]; then
  if ! cmp -s /tmp/sc2clud-unit.service /etc/systemd/system/sc2clud@.service 2>/dev/null; then
    chmod 644 /tmp/sc2clud-unit.service
    mv -f /tmp/sc2clud-unit.service /etc/systemd/system/sc2clud@.service
    systemctl daemon-reload
    echo 'unit updated + daemon-reload'
  else
    rm -f /tmp/sc2clud-unit.service
    echo 'unit unchanged'
  fi
fi
