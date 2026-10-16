#!/usr/bin/env bash
# ============================================================
# 只重启测试实例（不重新构建）。
# 用途：改了 env / unit / 想让 /dev 读新配置，或单纯排查重启问题。
# 改了代码请用 deploy/dev.sh（它会构建并装二进制）。
# ============================================================
set -euo pipefail

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

# drop-in（/etc/systemd/system/<unit>.service.d/）会覆盖 ExecStart，改过就必须重载
systemctl daemon-reload
systemctl restart sc2clud-debug
sleep 1
systemctl is-active sc2clud-debug
curl -fsS -o /dev/null -w "  /healthz（直连测试实例）-> %{http_code}\n" http://127.0.0.1:8081/healthz
log "/dev 已重启"
