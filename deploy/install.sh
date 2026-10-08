#!/usr/bin/env bash
# ============================================================
# SC2clud 单机部署（Debian / Ubuntu 系）
#
# 自适应：会探测 nginx 的安装方式（宝塔 / 官方包）、secure_link 模块、brotli 模块、
#        证书是否存在，据此裁剪 vhost 并决定下载下发方式。
# 幂等：重复执行不重建用户、不重新生成密钥（否则旧签名链接会失效）。
#
# 环境变量：
#   SC2CLUD_DOMAIN   站点域名或公网 IP（必填，默认 example.com 只作占位）
#   SC2CLUD_TLS      auto（默认）/ on / off —— auto 时按证书是否存在决定
#   SC2CLUD_PREFIX   安装根目录（默认 /srv/sc2clud）
#   SC2CLUD_USER     服务用户（默认 sc2clud）
#   SC2CLUD_BIN      二进制路径（默认 target/release/sc2clud）
#
# 用法：
#   pnpm -C web build && cargo build --release -p sc2clud-app
#   sudo SC2CLUD_DOMAIN=<域名或IP> deploy/install.sh
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${SC2CLUD_PREFIX:-/srv/sc2clud}"
SERVICE_USER="${SC2CLUD_USER:-sc2clud}"
DOMAIN="${SC2CLUD_DOMAIN:-example.com}"
TLS="${SC2CLUD_TLS:-auto}"
BIN_SRC="${SC2CLUD_BIN:-$REPO_ROOT/target/release/sc2clud}"
ENV_FILE="$PREFIX/sc2clud.env"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die '请用 root 执行（sudo deploy/install.sh）'
[ -f "$BIN_SRC" ] || die "找不到二进制 $BIN_SRC：先 cargo build --release -p sc2clud-app"
command -v nginx >/dev/null 2>&1 || warn '未安装 nginx：只会装应用，vhost 需手动接入'

# ---------- 1. 服务用户 ----------
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "服务用户 $SERVICE_USER 已存在"
else
  log "创建系统用户 $SERVICE_USER"
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ---------- 2. 目录 ----------
# 751/755 是刻意的：nginx 需要穿过 data 目录去读 blob，但不需要列目录能力。
# blob 是内容寻址的，真正的可见性由应用决定（/_blob 为 internal，/dl 需签名）。
log "准备目录 $PREFIX/data/{blobs,tmp,logs}"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 751 "$PREFIX" "$PREFIX/data"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 "$PREFIX/data/blobs"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$PREFIX/data/blobs/tmp"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$PREFIX/data/logs"
install -d -m 755 "$PREFIX/static"

# ---------- 3. 二进制与静态资源 ----------
log "安装二进制"
install -o root -g root -m 755 "$BIN_SRC" "$PREFIX/sc2clud"
if [ -d "$REPO_ROOT/crates/sc2clud-web/static" ]; then
  log '安装静态资源（含前端岛产物）'
  cp -r "$REPO_ROOT/crates/sc2clud-web/static/." "$PREFIX/static/"
  if [ ! -f "$PREFIX/static/islands/uploader.js" ]; then
    warn '缺少前端岛产物：先执行 pnpm -C web build'
  fi
else
  warn '未找到 crates/sc2clud-web/static：先 pnpm -C web build'
fi

# ---------- 4. 下载签名密钥（幂等）----------
if [ -f "$ENV_FILE" ] && grep -q '^SC2CLUD_DOWNLOAD_SECRET=' "$ENV_FILE"; then
  SECRET="$(grep '^SC2CLUD_DOWNLOAD_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  log '复用已有的下载签名密钥'
else
  SECRET="$(openssl rand -hex 32)"
  log '生成新的下载签名密钥（openssl rand -hex 32）'
fi
[ -n "$SECRET" ] || die '密钥为空，拒绝继续'

# ---------- 5. 探测 nginx 能力 ----------
NGINX_FEATURES="$(nginx -V 2>&1 || true)"
NGINX_VER="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"

if [ "$TLS" = 'auto' ]; then
  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then TLS=on; else TLS=off; fi
fi
if [ "$TLS" = 'on' ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  die "SC2CLUD_TLS=on 但找不到 /etc/letsencrypt/live/$DOMAIN/fullchain.pem"
fi

if printf '%s' "$NGINX_FEATURES" | grep -q 'http_secure_link_module'; then
  DOWNLOAD_MODE=secure_link
else
  DOWNLOAD_MODE=x_accel
fi

case "$TLS" in on) SCHEME=https ;; *) SCHEME=http ;; esac
log "决策：TLS=$TLS  下载下发=$DOWNLOAD_MODE  nginx=$NGINX_VER"

# ---------- 6. 写环境文件 ----------
log "写入 $ENV_FILE"
cat > "$ENV_FILE" <<EOF
# 由 deploy/install.sh 生成；权限 600，只允许 root 读取（systemd 以 root 读入后降权）。
SC2CLUD_BIND=127.0.0.1:8080
SC2CLUD_BASE_URL=$SCHEME://$DOMAIN
SC2CLUD_DATA_DIR=$PREFIX/data
SC2CLUD_DOWNLOAD_SECRET=$SECRET
SC2CLUD_DOWNLOAD_MODE=$DOWNLOAD_MODE
SC2CLUD_LOG=info
EOF
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------- 7. nginx vhost ----------
if command -v nginx >/dev/null 2>&1; then
  if [ -d /www/server/panel/vhost/nginx ]; then
    VHOST_DIR=/www/server/panel/vhost/nginx
    log '检测到宝塔面板：vhost 写入面板目录'
  else
    VHOST_DIR=/etc/nginx/sites-available
    install -d -m 755 "$VHOST_DIR" /etc/nginx/sites-enabled
  fi
  VHOST="$VHOST_DIR/sc2clud.conf"
  sed -e "s|__DOWNLOAD_SECRET__|$SECRET|g" -e "s|__DOMAIN__|$DOMAIN|g" \
      "$REPO_ROOT/deploy/nginx/sc2clud.conf.template" > "$VHOST"

  strip_region() {
    awk -v b="$2" -v e="$3" 'index($0,b){skip=1;next} index($0,e){skip=0;next} !skip' "$1" > "$1.tmp"
    mv "$1.tmp" "$1"
  }

  if [ "$TLS" = 'off' ]; then
    strip_region "$VHOST" '# @@REDIRECT_BEGIN@@' '# @@REDIRECT_END@@'
    strip_region "$VHOST" '# @@TLS_LISTEN_BEGIN@@' '# @@TLS_LISTEN_END@@'
    strip_region "$VHOST" '# @@TLS_ONLY_BEGIN@@' '# @@TLS_ONLY_END@@'
  else
    strip_region "$VHOST" '# @@PLAIN_LISTEN_BEGIN@@' '# @@PLAIN_LISTEN_END@@'
  fi

  if [ "$DOWNLOAD_MODE" = 'x_accel' ]; then
    warn 'nginx 无 secure_link 模块：删除 /dl 区块，改用 X-Accel-Redirect（安全等价，字节同样不走应用）'
    strip_region "$VHOST" '# @@SECURELINK_BEGIN@@' '# @@SECURELINK_END@@'
  else
    log 'nginx 带 secure_link：保留 /dl 签名直出通道'
  fi

  if printf '%s' "$NGINX_FEATURES" | grep -q 'http_brotli_static'; then
    log '带 brotli_static：静态资源发预压缩 .br'
  else
    warn '无 brotli 模块：注释 brotli_static（apt install libnginx-mod-http-brotli 可开启）'
    sed -i 's|^\([[:space:]]*\)brotli_static|\1# brotli_static|' "$VHOST"
  fi

  if [ -n "$NGINX_VER" ] && [ "$(printf '%s\n1.25.1\n' "$NGINX_VER" | sort -V | head -1)" != '1.25.1' ]; then
    warn "nginx $NGINX_VER < 1.25.1：退回旧的 http2 写法"
    sed -i 's|^\([[:space:]]*\)http2 on;|\1# http2 on;|; s|^\([[:space:]]*\)listen 443 ssl;|\1listen 443 ssl http2;|' "$VHOST"
  fi

  if [ "$VHOST_DIR" = '/etc/nginx/sites-available' ]; then
    ln -sf "$VHOST" /etc/nginx/sites-enabled/sc2clud.conf
  fi

  nginx -t || die "nginx 配置校验失败，请检查 $VHOST"
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  log "已生效：$VHOST"
fi

# ---------- 8. systemd ----------
log '安装并启动 systemd unit'
install -m 644 "$REPO_ROOT/deploy/systemd/sc2clud.service" /etc/systemd/system/sc2clud.service
systemctl daemon-reload
systemctl enable --now sc2clud.service

# ---------- 9. 内核网络调优 ----------
log '应用 sysctl（BBR + fq）'
install -m 644 "$REPO_ROOT/deploy/sysctl/99-sc2clud.conf" /etc/sysctl.d/99-sc2clud.conf
sysctl --system >/dev/null
log "拥塞控制：$(sysctl -n net.ipv4.tcp_congestion_control)  队列：$(sysctl -n net.core.default_qdisc)"

# ---------- 10. 自检 ----------
log '应用自检（check 子命令，不监听端口）'
( set -a; . "$ENV_FILE"; set +a; "$PREFIX/sc2clud" check ) || die '自检失败'
sleep 1
log "探活：$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz || echo '无响应')"

log '完成。'
cat <<EOF
  站点          $SCHEME://$DOMAIN
  下载下发      $DOWNLOAD_MODE
  服务          systemctl status sc2clud  /  journalctl -u sc2clud -f
  数据          $PREFIX/data/{sc2clud.sqlite3,blobs,logs}
  X-Accel 内部  /_blob/（internal，仅应用可触达）
EOF
