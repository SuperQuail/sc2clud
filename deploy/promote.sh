#!/usr/bin/env bash
# ============================================================
# 把已经在 /dev/ 验证过的版本推给**生产实例**。
# 只重启生产 unit；二进制此时已是新版（由 deploy/dev.sh 装好）。
# ============================================================
set -euo pipefail

PREFIX="${SC2CLUD_PREFIX:-/srv/sc2clud}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

log "确认二进制存在"
test -x "$PREFIX/sc2clud"

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
