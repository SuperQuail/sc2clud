# AGENTS.md — SC2clud

> 本文件是本仓库的**项目约定**，面向 AI 编码代理与人类协作者。
> 动手改代码前请先完整阅读；文档与代码冲突时，以代码为准并顺手修正文档。

---

## 1. 项目标识

| 项 | 值 |
| --- | --- |
| 项目名 | **SC2clud** |
| 定位 | 社区站（帖 / 评论 / 用户 / 通知）+ 轻量网盘 |
| 部署形态 | 单机 Linux，2 vCPU / 2 GB RAM / 10 Mbps 对称带宽 |
| 语言 | Rust（edition 2024，工具链固定在 `rust-toolchain.toml`） |
| 本地仓库 | `D:\Code\Rust\SC2clud\site`（外层 `SC2clud\` 放密钥，永不入库） |
| 当前版本 | `0.1.0-alpha.1`（`Cargo.toml` 的 `[workspace.package] version`） |
| 状态 | 🚧 基础工作区：核心链路已跑通并有端到端冒烟测试 |

## 2. 硬约束（技术栈由它们推导，不是偏好）

| 约束 | 数值 | 对技术栈的强制影响 |
| --- | --- | --- |
| 内存 | 2 GB 全机 | 应用常驻 ≤ 150 MB；排除 JVM 级重运行时 |
| 带宽 | 10 Mbps ≈ 1.25 MB/s 全站共享 | **网络是唯一瓶颈**；文件字节不得经过应用进程 |
| 磁盘 | 单机块存储 | 吞吐比带宽富余两个数量级，可放心做多副本、多档缩略图 |
| CPU | 2 核、长期空闲 | 定位为「用 CPU 换带宽」的资源池（预压缩、异步转码） |

**选型依据的顺序**（不是语言性能）：① 常驻内存；② 部署与运维复杂度；③ 文件路径安全性；④ 开发效率。

## 3. 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 / 运行时 | Rust 2024 + tokio（文件 IO 走流式异步，不阻塞 reactor） |
| Web | axum 0.8 + tower / tower-http（限流、超时、panic 兜底用中间件组合） |
| 模板 | askama（编译期模板，服务端渲染） |
| 元数据库 | SQLite（WAL）+ sqlx（运行时查询，见 §9 的迁移路径） |
| 文件存储 | 内容寻址本地盘（`StorageBackend` trait，预留 S3 实现） |
| 边缘 | nginx：sendfile 直出、secure_link 签名校验、limit_rate / limit_conn / limit_req、brotli_static |
| 前端 | 服务端渲染为默认；交互密集处挂 Vue 3 + TypeScript + Vite 前端岛 |
| 观测 | tracing + 异步批量落盘；`/healthz`、`/readyz` |
| 错误 | thiserror（领域）+ anyhow（应用边界） |

## 4. 仓库结构

```text
site/
├── crates/
│   ├── sc2clud-core/     领域核心：配置、路径安全、签名、限速、计数聚合（不依赖 Web/DB）
│   ├── sc2clud-storage/  StorageBackend trait + LocalFs（内容寻址）；s3 feature 预留实现位
│   ├── sc2clud-db/       SQLite 连接与 PRAGMA、编译期内嵌迁移、仓储函数
│   ├── sc2clud-web/      axum 路由、askama 模板、流式上传、签名下载
│   └── sc2clud-app/      可执行入口（serve / check / version）
├── migrations/           编译期嵌入二进制的 SQL 迁移
├── deploy/               nginx / systemd / sysctl / install.sh
├── docs/                 TECH_STACK、ARCHITECTURE、DEPLOY、BUDGETS
├── scripts/smoke.ps1     端到端冒烟测试（自拉起服务，29 项检查）
└── web/                  Vue 3 + TS + Vite 前端岛（产物进 sc2clud-web/static/islands）
```

**依赖方向（不可违反）**：`core` ← `storage` / `db` ← `web` ← `app`。
`core` 不得依赖 Web 框架、数据库驱动、具体存储实现，也不得启动异步运行时。

## 5. 常用命令

```bash
cargo fmt --all                                   # 格式化
cargo fmt --all -- --check                        # CI 校验
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace                            # 单元测试
pnpm -C web build                                 # 前端岛（先前端，后后端）
pwsh -File scripts/smoke.ps1                      # 端到端冒烟（自动起停服务）
cargo run -p sc2clud -- check                     # 配置与依赖自检
```

## 6. 不可随手改动的设计决策

1. **文件字节不进应用进程**。上传是固定缓冲的流式转发；下载只签发 URL，由 nginx `sendfile` 直出。
   任何「先把文件读进 `Vec<u8>`」的写法都违反 §2 的硬约束。
2. **下载有两种下发方式，都满足「字节不进应用进程」**（`download.mode`）：
   - `secure_link`：应用 302 到签名 URL，nginx 自校验。表达式 `"{expires}{uri}{remote_addr} {secret}"`
     必须与 `sc2clud-core/src/sign.rs` 逐字节一致；`bind_client_ip=false` 时 nginx 侧要同时删掉 `$remote_addr`。
     需要 nginx 带 `--with-http_secure_link_module`（官方包有，**宝塔自编译的常常没有**）。
   - `x_accel`：应用回 `X-Accel-Redirect`，nginx 从 `internal` location 直出（任何 nginx 都行，
     授权在请求时由应用判定）。`deploy/install.sh` 会探测能力并自动选择。
   stock nginx 只有 MD5（无 SHA-256 变体），「HMAC」是靠把密钥拼进被哈希表达式实现的带密钥 MAC。
3. **内容寻址 + 引用计数**：同一份内容只落一份盘；`files` 软删除、`blobs.refcount` 归零才真删盘。
4. **写热点禁止每请求 UPDATE**：浏览数、下载数先进 `Counters` 内存聚合，由后台任务批量落库。
5. **所有落盘路径必须过 `safety.rs`**：拼接后 `ensure_within` 白名单校验，用户文件名先过 `safe_file_name`。
6. **页面体积是硬预算**（见 `docs/BUDGETS.md`）：列表页 HTML ≤ 30 KB、首屏 JS ≤ 60 KB（brotli 后）。
   不要为了「方便」引入整站 SPA、CSS-in-JS 或整套 UI 组件库。
7. **发帖权限与可见性**（`core::review`，改动请同步 `AGENTS.md` 与测试）：
   - 讨论 / 资源 / 转载三类帖子对**所有已激活用户**开放，不设发布门槛；
   - **管理员及以上发帖跳过审核机**，直接发布（`review_for_author`，`automatic: false`）；
   - 审核中（`pending`）**只有作者本人与管理员及以上可见**，被拒（`rejected`）只有管理员可见；
   - 回复（`comments`）**没有图片列**——这是「回复不能带图」的数据层保证，不要在回复里加图。
8. **本站不承载启动器产物的字节**。`releases` / `release_assets` 只存版本与**外部直链**，
   下载走 `/api/v1/launcher/assets/{id}/go` 做 302 转链（便于统计与换镜像）。
   10 Mbps 的单机小站拉安装包会把出口带宽吃光——这条是产品约束，不是实现细节。

## 7. 编码约定

- 注释、日志、错误文案一律用中文；错误信息面向用户，不要暴露内部结构（`Storage` / `Database` 一律泛化）。
- 领域错误统一走 `sc2clud_core::Error`，HTTP 映射集中在 `sc2clud-web/src/error.rs`，不要在处理器里手写状态码。
- 新增配置项：改 `sc2clud-core/src/config.rs`（含默认值与 `validate`），并同步 `.env.example` 与 `docs/`。
- 新增迁移：加 `migrations/000N_xxx.sql`，不要改动已发布的迁移文件。
- 有外部副作用的函数必须有测试：流式哈希、限速、路径校验、引用计数、签名都是。

## 8. 质量门禁（提交前必过）

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pwsh -File scripts/smoke.ps1     # 改动触及上传/下载/存储/计数时必跑
```

## 9. 已知的脚手架边界（下一步要补的）

| 项 | 现状 | 下一步 |
| --- | --- | --- |
| 鉴权 | 未接入：内容归属 `repo::ensure_bootstrap_user` 里的 `demo` 用户 | 会话 Cookie（HttpOnly+SameSite）+ CSRF + argon2，替换 `demo_owner_id` |
| 上传限速主体 | 按客户端 IP 分桶 | 登录后换成 user id（改 `routes::client_subject` 一处） |
| 分片续传 | 建表与仓储函数已就绪（`upload_sessions`），HTTP 分片接口未接 | 提供 `POST/PATCH` 分片接口 + 合并 |
| S3 后端 | `StorageBackend` 抽象已定，`S3Backend` 是返回 `Unsupported` 的占位 | 补 SigV4 预签名与分片上传 |
| sqlx 编译期校验 | 当前用运行时查询（避免构建依赖数据库） | schema 稳定后切 `query!` + `cargo sqlx prepare` 离线缓存 |
| 缩略图 / 转码 | 表与任务队列已就绪（`post_images` / `image_jobs`），**工作线程未实现** | 接 `image` crate 的异步压缩线程 + 原图保留 API |
| 注册 / 登录 / 管理员页面 | ✅ 已完成（`/login`、`/register`、`/admin`，含激活与等级管理） | — |
| 帖子页面 | ✅ 已完成（feed / 详情 / 发帖 / 回复 / 分区 / 资源来源 / 封面图） | — |
| 夜间模式 | ✅ 已完成（跟随系统 + 手动切换，记在 localStorage） | — |
| 调试页 | ✅ 已完成（`/debug`，默认关闭；独立实例见 `deploy/systemd/sc2clud-debug.service`） | — |
| 启动器下载页 | `releases` 索引与转链函数已就绪，页面与 API 未接 | 补 `/download` 与 `/api/v1/launcher/latest` |
| **用户头像** | ✅ 已完成（浏览器侧裁剪压缩 ≤64KB；`/u/{handle}` 主页里换） | — |
| 前端岛发布 | 产物在 .gitignore 里，服务器无 Node | `pwsh -File scripts/push-islands.ps1`（构建 + 同步） |

### 头像实现（已完成，留档）

| 项 | 决定 |
| --- | --- |
| 压缩位置 | **在用户浏览器里压**（canvas），服务器只收结果——2 vCPU 的机器不花算力在转码上 |
| 体积上限 | 成品 **≤ 64 KB**（前端循环降质量/尺寸直到达标，服务端再校验一次） |
| 选区 | 用户自己框选裁剪区域（方形），前端预览 |
| 尺寸 | 建议输出 256×256 WebP/JPEG，够 40px 顶栏与 48px 列表用 |
| 存储 | 复用内容寻址存储（同一张头像多人用只落一份），`users.avatar_hash` 指向它 |
| 读取 | `/avatar/{hash}`，同帖子图片走 nginx `/_img/` 直出（字节不进应用进程） |
| 权限 | 只有本人能换头像；管理员可在面板里清掉违规头像 |
| 展示位 | 顶栏、帖子卡片作者、回复作者、管理员面板用户表 |
| 上传接口 | `POST /api/v1/me/avatar`（登录 + 已激活 + 磁盘闸门 + 魔数校验 + ≤64KB） |

## 10. 敏感数据

仓库**外层**目录（`D:\Code\Rust\SC2clud\`）放 SSH 私钥与生产环境变量，不属于任何 git 仓库：
`secrets/ssh/`、`secrets/env/production.env`。仓库内只保留 `.env.example` 模板。
不要在外层执行 `git init`，也不要把 `secrets/` 拷进 `site/` 或对它建软链接。

## 11. 开发与测试流程：先 dev，后生产

站点有**两个实例**，**各自的二进制与数据**（`dev.sh` 只写测试端，`promote.sh` 才发布到生产）：

| 实例 | 端点 | 数据目录 | 用途 |
| --- | --- | --- | --- |
| 生产 | `/`（对外） | `/srv/sc2clud/data`（二进制 `/srv/sc2clud/sc2clud`） | 只放已验证的版本 |
| 测试 | `/dev/`（对外，nginx `sub_filter` 补前缀） | `/srv/sc2clud-dev/data`（二进制 `/srv/sc2clud-dev/sc2clud`） | **所有开发与测试都在这里** |

流程：

```bash
# 1. 在 /dev 上发布新版本（只重启测试实例，生产继续跑旧进程）
bash deploy/dev.sh

# 2. 在 http://<域名>/dev/ 上验证（登录、点按钮、看页面）
#    /dev 与生产同域，所以 Cookie 名必须不同（SC2CLUD_COOKIE_NAME），
#    否则两边会话互相顶掉——见 deploy/systemd/sc2clud-debug.service

# 3.（可选）让 /dev 用生产数据来测：只读快照，不碰生产
bash deploy/dev-sync.sh

# 4. 验证通过后，才推给生产
bash deploy/promote.sh
```

要点：

- **两个容易踩的部署坑**：① `sqlx::migrate!` 编译期展开，增量编译下新增迁移可能不重编 →
  `dev.sh` 会先 `touch crates/sc2clud-db/src/lib.rs`；② `/etc/systemd/system/<unit>.service.d/` 里的
  drop-in 会覆盖 `ExecStart`，改完 unit 必须 `systemctl daemon-reload` 再重启，否则跑的还是旧二进制。
- **不要在生产的 `/` 上做任何交互式测试或写入**（包括自动化点击、造数据）。
- `/dev/` 上的路径前缀由 nginx 的 `sub_filter` 处理，应用代码里**不要**写 `/dev`。
- 生产数据快照进测试库是**只读**操作；反向绝不允许。
- 出问题的回滚：生产 unit 重启即可回到旧版本（二进制换成上一个 release 的即可）。

### 多人协作约定（都会往 dev 发）

**唯一入口是仓库里的脚本**，不要手工 `systemctl` / 不要给 unit 加覆盖 `ExecStart` 的 drop-in：

| 脚本 | 作用 |
| --- | --- |
| `bash deploy/dev.sh` | 拉 `main` → 构建 → 装二进制 → **只重启 /dev** |
| `bash deploy/dev-restart.sh` | 不重新构建，只重启 /dev（改了 env、排查用） |
| `bash deploy/dev-sync.sh` | 生产库**只读快照** → /dev 数据目录 |
| `bash deploy/promote.sh` | 把已在 /dev 验过的版本推给生产 |

规则：

1. **代码改动走 git**：本地/自己的分支改 → 推 `main` → `deploy/dev.sh`。
   直接在服务器 `/opt/sc2clud` 里改文件会被下一次 `dev.sh` 的 `reset --hard` 覆盖
   （脚本会先 `git stash` 备份，但别指望它）。
2. **两个实例各自独立**：测试端前缀 `/srv/sc2clud-dev`（二进制/静态/env 都在这里），
   生产端 `/srv/sc2clud`。`dev.sh` 只写测试前缀，碰不到生产；`promote.sh` 才把测试端那份二进制
   复制成生产二进制并重启生产 —— 所以「验证过再发布」是真的两道关。
3. 排查「代码改了没效果」先看两条：`systemctl cat sc2clud-debug`（有没有 drop-in 覆盖 ExecStart）
   与 `git -C /opt/sc2clud log --oneline -1`（服务器上到底是哪个提交）。
4. 改 unit / vhost 后必须 `systemctl daemon-reload` / `nginx -s reload`。
5. 数据与 Cookie 都是隔离的：prod `/srv/sc2clud/data` + `sc2clud_session`，
   dev `/srv/sc2clud-dev/data` + `sc2clud_dev_session`；**反向同步绝不允许**。
