#!/usr/bin/env bash
# ============================================================
# 把已经在 /dev/ 验证过的版本推给**生产实例**。
# 两个实例的二进制是**各自独立的**：这里把测试端那份复制成生产那份，再重启生产。
# ============================================================
set -euo pipefail

PREFIX="${SC2CLUD_PREFIX:-/srv/sc2clud}"
DEV_PREFIX="${SC2CLUD_DEV_PREFIX:-/srv/sc2clud-dev}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

log "确认测试端二进制存在（它就是待发布的版本）"
test -x "$DEV_PREFIX/sc2clud"
ls -l --time-style=+%m-%d_%H:%M "$DEV_PREFIX/sc2clud" "$PREFIX/sc2clud" 2>/dev/null | awk '{print "  " $NF "  " $6}'
install -m 0755 "$DEV_PREFIX/sc2clud" "$PREFIX/sc2clud"
log "已把测试端二进制发布为生产二进制"

log "同步静态资源（保留 islands：那份由本地 push-islands 维护）"
REPO="${SC2CLUD_REPO:-/opt/sc2clud}"
if [ -d "$REPO/crates/sc2clud-web/static" ]; then
  command -v rsync >/dev/null 2>&1 \
    && rsync -a --delete --exclude "islands/" "$REPO/crates/sc2clud-web/static/" "$PREFIX/static/" \
    || find "$REPO/crates/sc2clud-web/static" -maxdepth 1 -type f -exec cp -f {} "$PREFIX/static/" \;
fi

log "重启生产实例"
systemctl daemon-reload
systemctl restart sc2clud
sleep 1
systemctl is-active sc2clud

log "生产自检"
# 直连应用端口：经 nginx 时不带 Host 会落到面板默认站点，误报 404（踩过）
curl -fsS -o /dev/null -w "  /healthz -> %{http_code}\n" http://127.0.0.1:8080/healthz
curl -fsS -o /dev/null -w "  /readyz  -> %{http_code}\n" http://127.0.0.1:8080/readyz
curl -fsS -o /dev/null -w "  首页     -> %{http_code}\n" -H "Host: $(hostname -I | awk '{print $1}')" http://127.0.0.1/
