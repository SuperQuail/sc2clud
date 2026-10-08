#!/usr/bin/env bash
# ============================================================
# 把**生产数据快照**灌进测试实例，让 /dev/ 上测的是真数据。
#
# 只读生产库（VACUUM INTO 快照），只写测试数据目录，
# 不会碰生产库、不会碰生产 blob。
# ============================================================
set -euo pipefail

PROD_DB="${SC2CLUD_PROD_DB:-/srv/sc2clud/data/sc2clud.sqlite3}"
PROD_BLOBS="${SC2CLUD_PROD_BLOBS:-/srv/sc2clud/data/blobs}"
DEV_DIR="${SC2CLUD_DEV_DIR:-/srv/sc2clud/data-debug}"
DEV_DB="$DEV_DIR/sc2clud.sqlite3"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

[ -f "$PROD_DB" ] || { echo "找不到生产库 $PROD_DB" >&2; exit 1; }
mkdir -p "$DEV_DIR"

log "停测试实例（避免写一半）"
systemctl stop sc2clud-debug

log "快照生产库 → 测试库"
rm -f "$DEV_DB-wal" "$DEV_DB-shm"
sqlite3 "$PROD_DB" "VACUUM INTO '$DEV_DB'"
chown --reference="$PROD_DB" "$DEV_DB" 2>/dev/null || true

log "同步 blob 内容（图片/文件，通常很小）"
mkdir -p "$DEV_DIR/blobs"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$PROD_BLOBS/" "$DEV_DIR/blobs/"
else
  rm -rf "$DEV_DIR/blobs" && cp -a "$PROD_BLOBS" "$DEV_DIR/blobs"
fi

log "起测试实例"
systemctl start sc2clud-debug
sleep 1
systemctl is-active sc2clud-debug
curl -fsS -o /dev/null -w "  /dev/healthz -> %{http_code}\n" http://127.0.0.1:8081/healthz || true
log "完成：/dev/ 现在跟生产同数据，随便折腾"
