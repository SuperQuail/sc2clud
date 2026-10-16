#!/usr/bin/env bash
# ============================================================
# 只安装「本机构建好、已上传」的二进制到测试实例 —— 服务器**不编译**。
#
# 为什么：这台 2C2G 生产机跑 cargo build --release 会 OOM（2026-10-10 两次宕机），
# 所以构建搬回开发机（WSL，16G 内存），服务器只负责装与重启。
#
# 用法（在服务器上）：
#   bash deploy/dev-binary.sh [/path/to/uploaded/sc2clud]
# 默认取 $DEV_PREFIX/sc2clud-upload（由 deploy/local-build.ps1 上传）。
# ============================================================
set -euo pipefail

DEV_PREFIX="${SC2CLUD_DEV_PREFIX:-/srv/sc2clud-dev}"
SRC="${1:-$DEV_PREFIX/sc2clud-upload}"
SERVICE_USER="${SC2CLUD_USER:-sc2clud}"

[ -f "$SRC" ] || { echo "找不到上传的二进制：$SRC（先在开发机跑 deploy/local-build.ps1）" >&2; exit 1; }

echo "==> 安装二进制（$SRC -> $DEV_PREFIX/sc2clud）"
install -m 0755 "$SRC" "$DEV_PREFIX/sc2clud"
chown "$SERVICE_USER:$SERVICE_USER" "$DEV_PREFIX/sc2clud" 2>/dev/null || true

echo "==> 重启测试实例"
systemctl daemon-reload
systemctl restart sc2clud-debug
sleep 1
systemctl is-active sc2clud-debug

echo "==> 自检"
curl -fsS -o /dev/null -w "  /healthz -> %{http_code}\n" http://127.0.0.1:8081/healthz
echo "完成：去 http://<域名>/dev/ 验证"
