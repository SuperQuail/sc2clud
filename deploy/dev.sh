#!/usr/bin/env bash
# ============================================================
# 只更新**测试实例**（/dev/ 端点）。
#
# 流程：开发 → 跑这个脚本 → 在 http://<域名>/dev/ 上验证 → 没问题再跑 promote.sh
# 说明：二进制是同一个文件，正在运行的生产进程持有旧 inode，
#       所以「装新的二进制 + 只重启测试实例」不会影响正在服务的生产。
# ============================================================
set -euo pipefail

PREFIX="${SC2CLUD_PREFIX:-/srv/sc2clud}"
REPO="${SC2CLUD_REPO:-/opt/sc2clud}"
BRANCH="${SC2CLUD_BRANCH:-main}"
CARGO="${SC2CLUD_CARGO:-/root/.cargo/bin/cargo}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

log "拉取 $BRANCH"
cd "$REPO"
git fetch --quiet origin "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"

log "构建（nice 一下，别和线上抢 CPU）"
CARGO_BUILD_JOBS=2 nice -n 10 "$CARGO" build --release -p sc2clud-app

log "安装二进制（生产进程仍持有旧 inode，不受影响）"
install -m 0755 "$REPO/target/release/sc2clud" "$PREFIX/sc2clud"

log "同步静态资源到独立目录（生产那份不动）"
# 不能共用 /srv/sc2clud/static：那样改了 CSS 会立刻影响生产，就不是隔离了。
DEV_STATIC="$PREFIX/static-dev"
rm -rf "$DEV_STATIC"
cp -a "$REPO/crates/sc2clud-web/static" "$DEV_STATIC"
# 前端岛不在 git 里（服务器没有 Node），从生产那份拷过来
if [ -d "$PREFIX/static/islands" ]; then
  cp -a "$PREFIX/static/islands" "$DEV_STATIC/islands"
fi

log "重启测试实例"
systemctl restart sc2clud-debug
sleep 1
systemctl is-active sc2clud-debug

log "测试端点自检"
curl -fsS -o /dev/null -w "  /healthz（直连测试实例）-> %{http_code}\n" http://127.0.0.1:8081/healthz
log "完成：去 http://<域名>/dev/ 验证；确认后再跑 deploy/promote.sh"
