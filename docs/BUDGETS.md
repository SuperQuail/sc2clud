# 预算与检查方式

> 预算是这个项目的**硬约束**：2 vCPU / 2 GB / 10 Mbps 上，超预算不是「慢一点」，而是直接不可用。
> 任何破坏预算的改动都应被拒绝，或在本文档里先改预算并说明理由。

## 1. 应用资源

| 指标 | 目标 | 现状与依据 |
| --- | --- | --- |
| 应用常驻内存 | ≤ 150 MB | systemd `MemoryHigh=128M` / `MemoryMax=192M`；缓冲区都是有界常数 |
| 单请求内存 | ≤ 1 MB | 上传缓冲 = `stream_chunk_bytes`(64 KiB) × (1 + channel 深度 3) ≈ 256 KiB |
| 可用 page cache | ≥ 1.5 GB | SQLite 只留 16 MiB 页缓存 + 256 MiB mmap，其余交给 OS |
| 冷启动 | ≤ 1 s | 单静态二进制 + 内嵌迁移，无运行时依赖 |
| API P95 | ≤ 200 ms | 不含文件传输耗时；下载只做一次 DB 读 + 一次 MD5 |

## 2. 带宽

| 指标 | 目标 |
| --- | --- |
| 端口带宽 | 10 Mbps 对称 ≈ 1.25 MB/s |
| 并发下载 | ≥ 20 条，单条 ≥ 256 KB/s（`limit_rate 256k` + `limit_conn`） |
| 并发上传 | 单主体 256 KB/s（应用层令牌桶），全站 ≤ 5 条（信号量） |
| 单文件上限 | 本地存储 50 MB（`limits.max_upload_bytes`），对象存储后端可放宽到 2 GB |
| 月流量 | 按 3 TB 物理上限计，运行阈值 2.5 TB（vnstat 观测） |

## 3. 页面体积（brotli 后）

| 资源 | 预算 | 现状 |
| --- | --- | --- |
| 列表页 HTML | ≤ 30 KB | 首页为极简 SSR 模板，实测 < 5 KB |
| 详情页 HTML | ≤ 50 KB | 同上 |
| 首屏 CSS | ≤ 20 KB | `static/app.css`，brotli 后 ≈ 1 KB |
| 首屏 JS | ≤ 60 KB | 上传岛（Vue 3 运行时 + 组件），brotli 后 ≈ 20 KB |
| 列表页缩略图合计 | ≤ 150 KB | 缩略图功能尚未实现（必须异步化） |
| 单页首屏总计 | ≤ 250 KB ≈ 2 秒传输 | 由上述各项相加约束 |

## 4. 检查方式

```bash
# 静态资源体积（brotli 质量 11，与 nginx brotli_static 的口径一致）
node scripts/check-budgets.mjs

# 内存：跑起来之后看 cgroup
systemctl status sc2clud | grep Memory
cat /sys/fs/cgroup/system.slice/sc2clud.service/memory.current

# 带宽与流量
vnstat -h
```

`scripts/check-budgets.mjs` 在 CI 与本地都会跑：超预算直接失败，避免「先合进去再说」。
