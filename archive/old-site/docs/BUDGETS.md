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
| 首屏 JS（每页共享外壳） | ≤ 60 KB | `base.html` 挂的岛：`theme` + `post-images` + （`account` / `auth` 二选一，取较大者），brotli 后 ≈ 3.5 KB |
| 单个前端岛（含其 chunk） | ≤ 120 KB | 与 `web/vite.config.ts` 的注释一致。React 岛共享一个 `ui.js` chunk，只量入口会低估，因此按 import 闭包求和；当前最大 `issues.js` + chunk ≈ 66.6 KB（React 18 + Radix，§6.6 强制） |
| 列表页缩略图合计 | ≤ 150 KB | 缩略图功能尚未实现（必须异步化） |
| 单页首屏总计 | ≤ 250 KB ≈ 2 秒传输 | 由上述各项相加约束 |

**「首屏 JS」量的是每个页面真正会下载的那一份**，不是 `islands/` 下所有产物的总和 ——
没有任何页面会同时加载全部岛，那个总和既不是首屏、也不是任何一个单页的体积。
页面自己的岛（如帖子页的 `issues.js`）由「单个前端岛」这一行单独设限。

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

`scripts/check-budgets.mjs` 在 CI 与本地都会跑：三条断言（首屏 CSS / 首屏 JS / 单岛上限）任一超限即失败，
并额外校验「模板引用的岛确实存在」。改模板里的 island `<script>` 时，同步脚本顶部的 `SHARED` / `SHELL_ALTERNATIVES`。
## 具名豁免

| 岛 | 上限 | 理由 |
| --- | --- | --- |
| `editor.js` | 200 KB | 富文本编辑器（TipTap + ProseMirror + marked/turndown 往返）天生重；只在登录后的编辑页加载，不进首屏（首屏 3.5/60）。正文存储仍是 markdown，所以没有为它引入第二套渲染。 |

## 预算变更记录

| 日期 | 项 | 变化 | 理由 |
| --- | --- | --- | --- |
| 2026-10-11 | 首屏 CSS | 20 KB → **22 KB** | 首页外壳（app.css + home.css + forum.css）实测 20.1 KB，已超旧预算 0.1 KB。
| | | | 触发项是顶栏「未读通知红点」样式（`.home-icon-btn .badge`），规则本身已压到最小（两行、无注释）。
| | | | 没有靠删别处样式来凑数；留 2 KB 余量给后续同类小样式，超过就要先重构 CSS。 |
