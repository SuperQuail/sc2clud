#!/usr/bin/env bash
# ============================================================
# 把已经在 /dev/ 验证过的版本推给**生产实例**。
# 两个实例的二进制是**各自独立的**：这里把测试端那份复制成生产那份，再重启生产。
# ============================================================
set -euo pipefail

PREFIX="${SC2CLUD_PREFIX:-/srv/sc2clud}"
DEV_PREFIX="${SC2CLUD_DEV_PREFIX:-/srv/sc2clud-dev}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/artifacts.sh"
log "校验已验收的 DEV 整套产物"
verify_release "$DEV_PREFIX"
install -d -m 0755 "$PREFIX"
STAGE=$(mktemp -d "$PREFIX/.release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
cp -a "$DEV_PREFIX/sc2clud" "$DEV_PREFIX/static" "$DEV_PREFIX/SHA256SUMS" "$STAGE/"
verify_release "$STAGE"
# 备份必须成功后才开始替换，保留原二进制、完整静态及已有校验清单。
install -d -m 0755 "$PREFIX/releases"
BACKUP=$(mktemp -d "$PREFIX/releases/$(date +%Y%m%d-%H%M%S).XXXXXX")
cp -a "$PREFIX/sc2clud" "$PREFIX/static" "$BACKUP/"
if [ -f "$PREFIX/SHA256SUMS" ]; then cp -a "$PREFIX/SHA256SUMS" "$BACKUP/"; fi
log "上一套产物备份：$BACKUP"
mv -f "$STAGE/sc2clud" "$PREFIX/sc2clud"
rm -rf "$PREFIX/static"
mv "$STAGE/static" "$PREFIX/static"
mv -f "$STAGE/SHA256SUMS" "$PREFIX/SHA256SUMS"

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
