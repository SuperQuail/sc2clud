# 部署（单机 Linux）

目标形态：**单个静态二进制 + 一个 systemd unit + nginx**。没有容器编排，没有蓝绿。

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| 系统 | Debian 12 / Ubuntu 22.04+（或等价发行版） |
| 内核 | ≥ 4.9（BBR 需要），建议 ≥ 5.10 |
| nginx | ≥ 1.25.1（`http2 on` 语法），需 `--with-http_secure_link_module` |
| 内存 | 2 GB（应用 150 MB + SQLite 16 MB + page cache 其余） |
| swap | 2 GB 兜底（安全网，不是容量来源） |
| 域名 / 证书 | certbot 申请 Let's Encrypt 证书 |

## 2. 发布（顺序不可颠倒）

```bash
# 1) 先前端：产物落到 crates/sc2clud-web/static/islands/
pnpm -C web install --frozen-lockfile
pnpm -C web build

# 2) 再后端：单二进制
cargo build --release -p sc2clud-app

# 3) 一键安装（幂等，可重复执行）
sudo SC2CLUD_DOMAIN=example.com deploy/install.sh
```

安装脚本做的事：创建 `sc2clud` 系统用户与 `/srv/sc2clud/data/{blobs,tmp,logs}`、安装二进制与静态资源、
生成（或复用）下载签名密钥并同时写入环境文件与 nginx 配置、装 nginx 站点与 systemd unit、应用 sysctl、跑一次自检。

**密钥幂等**：已存在的 `SC2CLUD_DOWNLOAD_SECRET` 会被复用；否则每次部署都会让旧签名链接失效。

## 3. systemd 加固要点

见 [deploy/systemd/sc2clud.service](../deploy/systemd/sc2clud.service)：

| 指令 | 值 | 理由 |
| --- | --- | --- |
| `MemoryHigh` / `MemoryMax` | 128M / 192M | 先限速再硬墙；常驻预算 ≤ 150 MB |
| `OOMScoreAdjust` | 200 | OOM 时优先牺牲应用，保住 nginx 与数据库 |
| `ProtectSystem=strict` + `ReadWritePaths=/srv/sc2clud/data` | — | 除数据目录外全盘只读 |
| `PrivateTmp` / `ProtectHome` / `NoNewPrivileges` | — | 常规加固 |
| `CapabilityBoundingSet=` | 空 | 应用不需要任何 capability（只监听 > 1024 端口） |
| `SystemCallFilter=@system-service` | — | 只允许常规系统调用集合 |

## 4. nginx 的职责（应用不重复做）

见 [deploy/nginx/sc2clud.conf.template](../deploy/nginx/sc2clud.conf.template)：

| 职责 | 关键指令 |
| --- | --- |
| 静态资源直出 | `sendfile on`、`sendfile_max_chunk 512k`、`tcp_nopush on` |
| 文件下载直出 | `location /dl/` + `secure_link` + `secure_link_md5` |
| 带宽治理 | `limit_rate_after 256k`、`limit_rate 256k`、`limit_conn`（单 IP 与全站两级） |
| 请求限流 | `limit_req zone=... burst=16 nodelay` |
| 预压缩直发 | `brotli_static on`（缺模块时脚本自动注释，退回 `gzip_static`） |
| 请求体 | `client_max_body_size 52m`、`client_body_timeout 60s` |
| 上传透传 | `proxy_request_buffering off`（不落 nginx 临时文件，边收边转） |
| TLS | 终止于此，`X-Real-IP` / `X-Forwarded-For` 传给应用 |

## 5. 内核参数

`deploy/sysctl/99-sc2clud.conf`：`tcp_congestion_control=bbr`、`default_qdisc=fq`、`somaxconn=4096`、
`tcp_slow_start_after_idle=0`、`swappiness=10`。细管道 + 客户端丢包场景下，BBR 相比 CUBIC 能显著提升有效吞吐利用率。

## 6. 日常运维

```bash
systemctl status sc2clud              # 状态与内存占用
journalctl -u sc2clud -f              # 实时日志（stdout）
ls -lh /srv/sc2clud/data/logs/        # 落盘日志（按天切割）
curl -s localhost/healthz             # 存活
curl -s localhost/readyz              # 就绪（会真打数据库与 blob 根）

# 备份：数据库要热备，blob 是内容寻址、可增量同步
sqlite3 /srv/sc2clud/data/sc2clud.sqlite3 ".backup '/srv/sc2clud/data/backup-$(date +%F).sqlite3'"
rsync -a --delete /srv/sc2clud/data/blobs/ /backup/blobs/

# 升级：替换二进制 → 重启 → 冒烟
sudo systemctl restart sc2clud && sleep 1 && curl -s -o /dev/null -w '%{http_code}\n' localhost/readyz
```

## 7. 故障速查

| 现象 | 先看什么 |
| --- | --- |
| 启动即退出 | `journalctl -u sc2clud -n 50`；多半是 `SC2CLUD_DOWNLOAD_SECRET` 未配置（启动自检会拒绝） |
| 下载 403 | 签名密钥与应用不一致：比对 `sc2clud.env` 与 nginx 配置里的密钥 |
| 下载 410 | 签名过期（正常 TTL 300 秒）；检查服务器时钟 |
| 上传 413 | 超出 `limits.max_upload_bytes`（默认 50 MB）或用户配额 |
| 上传 429 | 全站并发上传（默认 5 条）或单主体令牌桶 |
| 页面 404 但接口正常 | 静态资源未构建：`pnpm -C web build` 后重跑安装脚本 |
| 内存持续爬升 | `systemctl status` 看 cgroup；检查是否有人引入了按文件大小增长的缓冲 |

## 8. 回滚

二进制是自包含的，回滚即换回旧二进制并重启。数据库迁移是**只前进**的：
发布前用上面的 `.backup` 留一份快照；若新版本改了 schema，回滚二进制前先从快照恢复数据库。
