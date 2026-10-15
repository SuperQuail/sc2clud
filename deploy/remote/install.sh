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
#
# 2026-10-13: the contract as first written made a failed deploy unretryable -- the release was
# published in step 5, a later step failed and rolled current back, and now the SAME version could
# never be installed again ('already exists'). It bit three times in one afternoon and each retry
# needed a throwaway commit just to get a new hash. So the boundary is now drawn where it matters:
#   - refuse if the existing release is (or is being made) CURRENT -- that is what 'which code is live' means;
#   - replace an existing NON-current release: it can only have come from an attempt that never got
#     activated. Trade-off: a release you kept two generations back for a manual rollback can be
#     overwritten by a re-install of the same version. Acceptable here; a rollback that matters
#     targets the previous current, which this guard still protects.
if [ -e "$SC2CLUD_DIR/releases/$version" ]; then
  if [ "$(readlink "$SC2CLUD_DIR/current" 2>/dev/null || true)" = "releases/$version" ]; then
    echo "release $version is the CURRENT release -- pick another version" >&2
    exit 1
  fi
  echo "note: replacing existing non-current release $version (an earlier attempt that never activated)"
  rm -rf "$SC2CLUD_DIR/releases/$version"
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

# 设计房间（DevRoom）的静态目录：nginx 以 www 用户读不到 releases/（umask 077 + root 所有），
# 所以房间发布到 $SC2CLUD_DIR/dist/devroom（世界可读），nginx 的 /dev/devroom/ 指的就是它。
# **这一步不能省**：2026-10-15 实测它停在 10-13 的手工拷贝上两天，期间所有「房间出图确认」看的都是旧包。
# 只有带 devroom 的产物（dev 构建）才有这一步；生产产物没有这个目录。
if [ -d "$SC2CLUD_DIR/releases/$version/web/dist/devroom" ]; then
  rm -rf "$SC2CLUD_DIR/dist/devroom.new"
  cp -a "$SC2CLUD_DIR/releases/$version/web/dist/devroom" "$SC2CLUD_DIR/dist/devroom.new"
  chmod -R a+rX "$SC2CLUD_DIR/dist/devroom.new"
  if [ -d "$SC2CLUD_DIR/dist/devroom" ]; then mv "$SC2CLUD_DIR/dist/devroom" "$SC2CLUD_DIR/dist/devroom.old"; fi
  mv "$SC2CLUD_DIR/dist/devroom.new" "$SC2CLUD_DIR/dist/devroom"
  rm -rf "$SC2CLUD_DIR/dist/devroom.old"
  echo "devroom   : published $(find "$SC2CLUD_DIR/dist/devroom" -type f | wc -l) files"
fi

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
