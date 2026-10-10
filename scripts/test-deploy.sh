#!/usr/bin/env bash
# 真实脚本 + 临时文件；仅替换 git 网络、编译器、服务管理与健康检查。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/repo/deploy" "$T/repo/web/src" "$T/repo/crates/sc2clud-db/src" "$T/repo/crates/sc2clud-web/static/islands" "$T/repo/target/release" "$T/bin" "$T/prod/static/islands" "$T/dev/static"
cp "$ROOT/deploy/"*.sh "$T/repo/deploy/"
printf 'source\n' > "$T/repo/web/src/post-feature.ts"
git -C "$T/repo" init -q
git -C "$T/repo" config core.autocrlf false
mkdir -p "$T/repo/web/public"
printf 'asset\n' > "$T/repo/web/public/old asset.txt"
git -C "$T/repo" add web
for entry in uploader avatar admin home auth post-images account theme post-feature; do printf 'new-%s\n' "$entry" > "$T/repo/crates/sc2clud-web/static/islands/$entry.js"; done
printf '#!/bin/sh\n#new-binary\n' > "$T/repo/target/release/sc2clud"
printf '#!/bin/sh\n#old-binary\n' > "$T/prod/sc2clud"
printf 'old-js\n' > "$T/prod/static/islands/old.js"
printf 'active-dev\n' > "$T/dev/sc2clud"
printf 'active-static\n' > "$T/dev/static/active.txt"
chmod +x "$T/prod/sc2clud" "$T/repo/target/release/sc2clud"
REAL_GIT=$(command -v git)
cat > "$T/bin/git" <<EOF
#!/usr/bin/env bash
case "\$1" in fetch|reset) exit 0;; esac
exec "$REAL_GIT" "\$@"
EOF
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$SERVICE_LOG"\n' > "$T/bin/systemctl"
for cmd in cargo curl sleep; do printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/$cmd"; done
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" SERVICE_LOG="$T/services" SC2CLUD_REPO="$T/repo" SC2CLUD_PREFIX="$T/prod" SC2CLUD_DEV_PREFIX="$T/dev" SC2CLUD_CARGO="$T/bin/cargo"
run_dev() { bash "$T/repo/deploy/dev.sh" > "$T/output" 2>&1; }
unchanged() { test "$(cat "$T/dev/sc2clud")" = active-dev; test -f "$T/dev/static/active.txt"; test ! -e "$T/services"; }
# 缺少 manifest 必须在安装二进制之前拒绝。
if run_dev; then echo 'FAIL: 缺产物证明仍然发布'; exit 1; fi
unchanged
echo 'PASS: 缺产物不替换、不重启'
ISLANDS="$T/repo/crates/sc2clud-web/static/islands"
mkdir -p "$T/repo/scripts"
cp "$ROOT/scripts/islands-manifest.mjs" "$T/repo/scripts/"
node "$T/repo/scripts/islands-manifest.mjs"
printf 'changed\n' >> "$T/repo/web/src/post-feature.ts"
if run_dev; then echo 'FAIL: 来源版本不符仍然发布'; exit 1; fi
unchanged
echo 'PASS: 来源不符不替换、不重启'
printf 'source\n' > "$T/repo/web/src/post-feature.ts"
git -C "$T/repo" mv "web/public/old asset.txt" "web/public/new asset.txt"
if run_dev; then echo 'FAIL: 同内容重命名后旧产物仍然发布'; exit 1; fi
unchanged
git -C "$T/repo" mv "web/public/new asset.txt" "web/public/old asset.txt"
echo 'PASS: 同内容重命名拒绝旧产物、不替换、不重启'
printf 'stale\n' > "$ISLANDS/stale.js"
if run_dev; then echo 'FAIL: 清单外旧 JS 仍然发布'; exit 1; fi
unchanged
rm "$ISLANDS/stale.js"
echo 'PASS: 清单外旧 JS 不替换、不重启'
mv "$ISLANDS/post-feature.js" "$T/missing"
if run_dev; then echo 'FAIL: 缺精华入口仍然发布'; exit 1; fi
unchanged
echo "PASS: 缺精华入口不替换、不重启"
mv "$T/missing" "$ISLANDS/post-feature.js"
run_dev
grep -q new-binary "$T/dev/sc2clud"
test ! -e "$T/dev/static/islands/old.js"
test ! -e "$T/dev/static/islands/islands"
echo 'PASS: DEV 完整新静态，无生产旧 JS 或嵌套'
rm "$T/services"
printf 'tampered\n' >> "$T/dev/static/islands/home.js"
if bash "$T/repo/deploy/promote.sh" > "$T/output" 2>&1; then echo 'FAIL: DEV 被改仍然发布'; exit 1; fi
grep -q old-binary "$T/prod/sc2clud"
test -f "$T/prod/static/islands/old.js"
test ! -e "$T/services"
run_dev
printf 'wrong-repo\n' > "$ISLANDS/home.js"
bash "$T/repo/deploy/promote.sh" > "$T/output" 2>&1
test "$(cat "$T/prod/static/islands/home.js")" = new-home
grep -q new-binary "$T/prod/sc2clud"
backup=$(find "$T/prod/releases" -mindepth 1 -maxdepth 1 -type d | head -1)
grep -q old-binary "$backup/sc2clud"
test "$(cat "$backup/static/islands/old.js")" = old-js
restore() {
  cp "$backup/sc2clud" "$T/prod/sc2clud"
  rm -rf "$T/prod/static"
  cp -a "$backup/static" "$T/prod/static"
  if [ -f "$backup/SHA256SUMS" ]; then
    cp "$backup/SHA256SUMS" "$T/prod/SHA256SUMS"
  else
    rm -f "$T/prod/SHA256SUMS"
  fi
}
restore
grep -q old-binary "$T/prod/sc2clud"
test -f "$T/prod/static/islands/old.js"
if [ -e "$T/prod/SHA256SUMS" ]; then echo 'FAIL: 无清单旧备份回滚后遗留新清单'; exit 1; fi
echo 'PASS: promote 使用 DEV，预检拒绝损坏，旧整套可恢复'

# 已有完整清单的生产版本，下一轮发布后应连同旧清单恢复。
bash "$T/repo/deploy/promote.sh" > "$T/output" 2>&1
cp "$T/prod/SHA256SUMS" "$T/previous-sums"
printf 'next-static\n' > "$T/dev/static/extra.txt"
source "$ROOT/deploy/artifacts.sh"
seal_release "$T/dev"
bash "$T/repo/deploy/promote.sh" > "$T/output" 2>&1
backup=$(find "$T/prod/releases" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r candidate; do
  if [ -f "$candidate/SHA256SUMS" ]; then printf '%s\n' "$candidate"; fi
done)
restore
cmp "$T/previous-sums" "$T/prod/SHA256SUMS"
test ! -e "$T/prod/static/extra.txt"
verify_release "$T/prod"
echo 'PASS: 有清单旧备份回滚恢复旧清单并通过整套校验'
