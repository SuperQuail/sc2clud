#!/usr/bin/env bash
# 被 dev/promote 共用；预检查只读，任何失败都由 set -e 中止发布。
verify_inventory() {
  # 除了内容哈希也比对文件集合，避免清单外旧 JS 随目录进入发布。
  (cd "$1"; diff -u <(find "${@:2}" -type f | LC_ALL=C sort) \
    <(sed -E 's/^[a-f0-9]{64} [ *]//' SHA256SUMS | LC_ALL=C sort))
}
verify_islands() {
  local dir=$1 entry
  for entry in uploader avatar admin home auth post-images account theme post-feature; do
    test -s "$dir/$entry.js"
    grep -Eq "^[a-f0-9]{64} [ *]$entry\.js$" "$dir/SHA256SUMS"
  done
  test ! -e "$dir/islands"
  (cd "$dir"; sha256sum --check --status SHA256SUMS)
  # 清单本身不自哈希，find 统一去掉 ./ 前缀。
  (cd "$dir"; diff -u <(find . -type f ! -name SHA256SUMS | sed 's|^./||' | LC_ALL=C sort) \
    <(sed -E 's/^[a-f0-9]{64} [ *]//' SHA256SUMS | LC_ALL=C sort))
}
verify_source() {
  local repo=$1 dir=$2 actual
  actual=$(cd "$repo"; git ls-files -z web | xargs -0 git hash-object | sha256sum | cut -d ' ' -f1)
  test "$actual" = "$(cat "$dir/SOURCE.sha256")"
}
seal_release() {
  (cd "$1"; find sc2clud static -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
}
verify_release() {
  test -x "$1/sc2clud"
  verify_islands "$1/static/islands"
  (cd "$1"; sha256sum --check --status SHA256SUMS)
  verify_inventory "$1" sc2clud static
}
