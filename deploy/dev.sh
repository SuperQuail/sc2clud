#!/usr/bin/env bash
# ============================================================
# 只更新**测试实例**（/dev/ 端点）。
#
# 流程：开发 → 跑这个脚本 → 在 http://<域名>/dev/ 上验证 → 没问题再跑 promote.sh
# 隔离：测试实例有**自己的前缀**（$DEV_PREFIX），本脚本只写那里，
#       生产用的 /srv/sc2clud/sc2clud 一个字节都不会碰。
# ============================================================
set -euo pipefail

PREFIX="${SC2CLUD_PREFIX:-/srv/sc2clud}"
# 测试实例自己的前缀：二进制 / 静态 / env 都在这里，与生产目录无关
DEV_PREFIX="${SC2CLUD_DEV_PREFIX:-/srv/sc2clud-dev}"
REPO="${SC2CLUD_REPO:-/opt/sc2clud}"
BRANCH="${SC2CLUD_BRANCH:-main}"
CARGO="${SC2CLUD_CARGO:-/root/.cargo/bin/cargo}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

log "拉取 $BRANCH"
cd "$REPO"
git fetch --quiet origin "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"

log "构建（nice 一下，别和线上抢 CPU）"
# sqlx::migrate! 是编译期展开的：增量编译下新增迁移文件可能不触发重编，
# 结果就是「二进制装上了、迁移却没跑」（踩过一次，排查了很久）。
touch "$REPO/crates/sc2clud-db/src/lib.rs"
CARGO_BUILD_JOBS=2 nice -n 10 "$CARGO" build --release -p sc2clud-app

log "安装二进制到测试前缀（生产那份不碰）"
install -d -m 0755 "$DEV_PREFIX"
install -m 0755 "$REPO/target/release/sc2clud" "$DEV_PREFIX/sc2clud"

log "同步静态资源到测试前缀"
DEV_STATIC="$DEV_PREFIX/static"
rm -rf "$DEV_STATIC"
cp -a "$REPO/crates/sc2clud-web/static" "$DEV_STATIC"
# 前端岛不在 git 里，服务器也没 Node：
#   1) 优先用开发者本地上传的产物（/srv/sc2clud-dev/islands-upload，见 deploy/islands-push.ps1）；
#   2) 没有才退回生产那份（只读拷贝）。dev 永远有自己的优先来源，不去改生产目录。
DEV_UPLOAD="$DEV_PREFIX/islands-upload"
if [ -d "$DEV_UPLOAD" ] && [ -n "$(ls -A "$DEV_UPLOAD" 2>/dev/null)" ]; then
  log "使用本地上传的前端岛产物（$DEV_UPLOAD）"
  cp -a "$DEV_UPLOAD/." "$DEV_STATIC/islands/"
elif [ -d "$PREFIX/static/islands" ]; then
  log "本地上传目录为空，退回生产那份前端岛（只读）"
  cp -a "$PREFIX/static/islands" "$DEV_STATIC/islands"
fi

log "重启测试实例"
# 必须先 daemon-reload：/etc/systemd/system/<unit>.service.d/ 里的 drop-in 会覆盖 ExecStart，
# 不重载的话重启的还是别人那份二进制（踩过一次）。
systemctl daemon-reload
systemctl restart sc2clud-debug
sleep 1
systemctl is-active sc2clud-debug

log "测试端点自检"
curl -fsS -o /dev/null -w "  /healthz（直连测试实例）-> %{http_code}\n" http://127.0.0.1:8081/healthz
log "完成：去 http://<域名>/dev/ 验证；确认后再跑 deploy/promote.sh"
