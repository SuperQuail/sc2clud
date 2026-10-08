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

log "重启生产实例"
systemctl restart sc2clud
sleep 1
systemctl is-active sc2clud

log "生产自检"
curl -fsS -o /dev/null -w "  /healthz -> %{http_code}\n" http://127.0.0.1/healthz
curl -fsS -o /dev/null -w "  /readyz  -> %{http_code}\n" http://127.0.0.1/readyz
curl -fsS -o /dev/null -w "  首页     -> %{http_code}\n" http://127.0.0.1/
