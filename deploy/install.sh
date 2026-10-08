#!/usr/bin/env bash
# ============================================================
# SC2clud 单机部署（Debian / Ubuntu 系）
#
# 幂等：重复执行不会重复创建用户、不会重新生成密钥（避免旧签名链接失效）。
# 不做的事：不装 nginx/systemd 之外的依赖、不碰 TLS 证书（交给 certbot）、不做蓝绿。
#
# 用法：
#   cargo build --release -p sc2clud-app
#   pnpm -C web build                    # 必须先构建前端产物
#   sudo SC2CLUD_DOMAIN=example.com deploy/install.sh
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${SC2CLUD_PREFIX:-/srv/sc2clud}"
SERVICE_USER="${SC2CLUD_USER:-sc2clud}"
DOMAIN="${SC2CLUD_DOMAIN:-example.com}"
BIN_SRC="${SC2CLUD_BIN:-$REPO_ROOT/target/release/sc2clud}"
ENV_FILE="$PREFIX/sc2clud.env"
NGINX_SITE="/etc/nginx/sites-available/sc2clud.conf"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die '请用 root 执行（sudo deploy/install.sh）'
[ -f "$BIN_SRC" ] || die "找不到二进制 $BIN_SRC：先 cargo build --release -p sc2clud-app"

# ---------- 1. 服务用户 ----------
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "服务用户 $SERVICE_USER 已存在"
else
  log "创建系统用户 $SERVICE_USER"
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ---------- 2. 目录（同级 data 目录约定）----------
log "准备目录 $PREFIX/data/{blobs,tmp,logs}"
for dir in "$PREFIX" "$PREFIX/data" "$PREFIX/data/blobs" "$PREFIX/data/blobs/tmp" "$PREFIX/data/logs"; do
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$dir"
done
install -d -m 755 "$PREFIX/static"

# ---------- 3. 二进制与静态资源 ----------
log "安装二进制 $BIN_SRC"
install -o root -g root -m 755 "$BIN_SRC" "$PREFIX/sc2clud"
if [ -d "$REPO_ROOT/crates/sc2clud-web/static" ]; then
  log '安装静态资源（含前端岛产物）'
  cp -r "$REPO_ROOT/crates/sc2clud-web/static/." "$PREFIX/static/"
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

log "写入 $ENV_FILE"
cat > "$ENV_FILE" <<EOF
# 由 deploy/install.sh 生成；权限 600，只允许 root 读取（systemd 以 root 读入后降权）。
SC2CLUD_BIND=127.0.0.1:8080
SC2CLUD_BASE_URL=https://$DOMAIN
SC2CLUD_DATA_DIR=$PREFIX/data
SC2CLUD_DOWNLOAD_SECRET=$SECRET
SC2CLUD_LOG=info
EOF
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------- 5. nginx ----------
if command -v nginx >/dev/null 2>&1; then
  log '安装 nginx 站点配置'
  install -d /etc/nginx/sites-available /etc/nginx/sites-enabled
  sed -e "s|__DOWNLOAD_SECRET__|$SECRET|g" -e "s|example\.com|$DOMAIN|g" \
      "$REPO_ROOT/deploy/nginx/sc2clud.conf.template" > "$NGINX_SITE"
  if nginx -V 2>&1 | grep -q 'http_brotli_static'; then
    log '检测到 brotli_static：静态资源发预压缩 .br'
  else
    warn '未检测到 brotli 模块，已注释 brotli_static（可 apt install libnginx-mod-http-brotli）'
    sed -i 's|^\([[:space:]]*\)brotli_static|\1# brotli_static|' "$NGINX_SITE"
  fi
  ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/sc2clud.conf
  nginx -t || die 'nginx 配置校验失败，已保留原配置路径：'"$NGINX_SITE"
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
else
  warn '未安装 nginx：跳过站点配置（请手动引入 deploy/nginx/sc2clud.conf.template）'
fi

# ---------- 6. systemd ----------
log '安装并启动 systemd unit'
install -m 644 "$REPO_ROOT/deploy/systemd/sc2clud.service" /etc/systemd/system/sc2clud.service
systemctl daemon-reload
systemctl enable --now sc2clud.service

# ---------- 7. 内核网络调优 ----------
log '应用 sysctl（BBR + fq）'
install -m 644 "$REPO_ROOT/deploy/sysctl/99-sc2clud.conf" /etc/sysctl.d/99-sc2clud.conf
sysctl --system >/dev/null
log "拥塞控制算法：$(sysctl -n net.ipv4.tcp_congestion_control)"

# ---------- 8. 自检 ----------
log '应用自检（check 子命令，不监听端口）'
if ( set -a; . "$ENV_FILE"; set +a; "$PREFIX/sc2clud" check ); then
  log '自检通过'
else
  die '自检失败，请看上面的输出'
fi

systemctl --no-pager --lines=5 status sc2clud.service || true
log '完成。常用命令：'
cat <<EOF
  systemctl status sc2clud         # 服务状态
  journalctl -u sc2clud -f         # 实时日志
  curl -s https://$DOMAIN/healthz  # 存活探针
  $PREFIX/data/sc2clud.sqlite3     # 元数据库（WAL）
  $PREFIX/data/blobs/              # 内容寻址文件（<ab>/<cd>/<hash>）
可选配置文件：$PREFIX/sc2clud.toml（环境变量优先）
EOF
