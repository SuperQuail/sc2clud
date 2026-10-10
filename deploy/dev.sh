#!/usr/bin/env bash
# ============================================================
# 只更新选定的测试实例（默认共享 /dev/，也支持独立功能实例）。
#
# 流程：功能分支 → 独立 DEV 验收 → 串行合入共享 DEV → 共享验收后发布生产
# 隔离：测试实例有**自己的前缀**（$DEV_PREFIX），本脚本只写那里，
#       生产用的 /srv/sc2clud/sc2clud 一个字节都不会碰。
# ============================================================
set -euo pipefail

# 测试实例自己的前缀：二进制 / 静态 / env 都在这里，与生产目录无关
DEV_PREFIX="${SC2CLUD_DEV_PREFIX:-/srv/sc2clud-dev}"
REPO="${SC2CLUD_REPO:-/opt/sc2clud}"
BRANCH="${SC2CLUD_BRANCH:-main}"
CARGO="${SC2CLUD_CARGO:-/root/.cargo/bin/cargo}"
DEV_SERVICE="${SC2CLUD_DEV_SERVICE:-sc2clud-debug}"
DEV_PORT="${SC2CLUD_DEV_PORT:-8081}"

# 先验证实例边界；任何错误均不得进入 git reset、构建或产物替换。
fail() { printf '实例配置无效：%s\n' "$*" >&2; exit 1; }
DEV_SERVICE="${DEV_SERVICE%.service}"
[[ "$DEV_SERVICE" =~ ^sc2clud-[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || fail '服务名必须是 sc2clud- 开头的普通服务单元'
[[ "$DEV_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || fail '端口必须是规范十进制整数'
(( DEV_PORT <= 65535 && DEV_PORT != 8080 )) || fail '端口超出范围或指向生产'
[[ "$DEV_PREFIX" == /* ]] || fail '测试目录必须是绝对路径'
DEV_PREFIX=$(realpath -m -- "$DEV_PREFIX")
case "$DEV_PREFIX" in /|/srv/sc2clud|/srv/sc2clud/*) fail '测试目录不得指向生产或根目录';; esac
if [[ "$DEV_SERVICE" == sc2clud-debug ]]; then
  [[ "$DEV_PORT" == 8081 ]] || fail '共享 DEV 服务只能使用 8081'
else
  [[ "$DEV_PORT" != 8081 ]] || fail '独立 DEV 不得探测共享端口 8081'
  case "$DEV_PREFIX" in /srv/sc2clud-dev|/srv/sc2clud-dev/*) fail '独立 DEV 必须使用自己的产物目录';; esac
fi
HEALTH_URL="http://127.0.0.1:$DEV_PORT/healthz"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

log "拉取 $BRANCH"
cd "$REPO"
git fetch --quiet origin "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"

source "$REPO/deploy/artifacts.sh"
log "校验本机上传的前端产物及来源"
verify_islands "$REPO/crates/sc2clud-web/static/islands"
verify_source "$REPO" "$REPO/crates/sc2clud-web/static/islands"

log "构建（nice 一下，别和线上抢 CPU）"
# sqlx::migrate! 是编译期展开的：增量编译下新增迁移文件可能不触发重编，
# 结果就是「二进制装上了、迁移却没跑」（踩过一次，排查了很久）。
touch "$REPO/crates/sc2clud-db/src/lib.rs"
CARGO_BUILD_JOBS=2 nice -n 10 "$CARGO" build --release -p sc2clud-app

log "准备完整测试产物（全部校验后才替换活跃文件）"
install -d -m 0755 "$DEV_PREFIX"
STAGE=$(mktemp -d "$DEV_PREFIX/.release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
install -m 0755 "$REPO/target/release/sc2clud" "$STAGE/sc2clud"
cp -a "$REPO/crates/sc2clud-web/static" "$STAGE/static"
verify_islands "$STAGE/static/islands"
verify_source "$REPO" "$STAGE/static/islands"
seal_release "$STAGE"
verify_release "$STAGE"
# 数据和 env 不在产物内；仅替换二进制与整套静态。
mv -f "$STAGE/sc2clud" "$DEV_PREFIX/sc2clud"
rm -rf "$DEV_PREFIX/static"
mv "$STAGE/static" "$DEV_PREFIX/static"
mv -f "$STAGE/SHA256SUMS" "$DEV_PREFIX/SHA256SUMS"

log "重启测试实例"
# 必须先 daemon-reload：/etc/systemd/system/<unit>.service.d/ 里的 drop-in 会覆盖 ExecStart，
# 不重载的话重启的还是别人那份二进制（踩过一次）。
systemctl daemon-reload
systemctl restart "$DEV_SERVICE"
sleep 1
systemctl is-active "$DEV_SERVICE"

log "测试端点自检"
curl -fsS -o /dev/null -w "  /healthz（直连测试实例）-> %{http_code}\n" "$HEALTH_URL"
log "完成：$DEV_SERVICE 本机健康检查 $HEALTH_URL"
if [[ "$DEV_SERVICE" == sc2clud-debug ]]; then
  log "去 http://<域名>/dev/ 验证；确认后按项目流程运行 deploy/promote.sh"
else
  log "独立 DEV 验收通过后，经审查串行合入共享 dev 分支并重新发布共享 DEV；独立实例不直接发布生产"
fi
