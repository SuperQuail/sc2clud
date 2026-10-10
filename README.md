# SC2clud

社区站（帖 / 评论 / 用户 / 通知）+ 轻量网盘，面向 **单机 Linux（2 vCPU / 2 GB / 10 Mbps 对称带宽）**。

技术栈的全部取舍都由硬约束推导而来，见 [AGENTS.md](AGENTS.md) §2 与 [docs/TECH_STACK.md](docs/TECH_STACK.md)。
一句话概括：**网络是唯一瓶颈，所以文件字节一律不经过应用进程。**

## 当前状态

基础工作区已就绪，核心链路**端到端跑通并有自动化验证**：

| 能力 | 状态 |
| --- | --- |
| 流式上传（恒定内存、边收边算 blake3） | ✅ 已实现，冒烟测试覆盖 |
| 秒传（客户端报哈希，服务端校验后 0 字节建引用） | ✅ 已实现 |
| 内容寻址存储 + 引用计数回收 | ✅ 已实现 |
| 签名下载（应用只签名，nginx `secure_link` + `sendfile` 直出） | ✅ 已实现，签名与 nginx 表达式逐字节对齐 |
| 应用层上传限速 + 并发闸门（nginx 无上传限速指令） | ✅ 已实现 |
| 写热点聚合（下载数/浏览数内存聚合后批量落库） | ✅ 已实现 |
| 社区内容（帖 / 评论 / 通知） | 🚧 表结构与发帖/列表接口就绪，前端页面为最小形态 |
| 鉴权、分片续传、S3 后端、缩略图 | ⏳ 见 [AGENTS.md §9](AGENTS.md) |

质量门禁：`cargo fmt --check`、`clippy -D warnings`、`cargo test --workspace`（49 项单元测试）、
`scripts/smoke.ps1`（29 项端到端检查）。

## 快速开始（本地）

```bash
# 0. 前置：Rust 1.94（rust-toolchain.toml 已固定）、Node 20+、pnpm

# 1. 先构建前端产物（发布顺序：前端 → 后端）
pnpm -C web install
pnpm -C web build

# 2. 起服务（数据写在 <exe 同级>/data，可用 SC2CLUD_DATA_DIR 覆盖）
export SC2CLUD_DOWNLOAD_SECRET=$(openssl rand -hex 32)
cargo run -p sc2clud -- check     # 配置与依赖自检
cargo run -p sc2clud               # 默认 serve，监听 127.0.0.1:8080

# 3. 用接口传一个文件
curl -X PUT --data-binary @photo.jpg \
  "http://127.0.0.1:8080/api/v1/files?name=photo.jpg"

# 4. 端到端冒烟测试（自动起停服务、真实上传下载、校验签名）
pwsh -File scripts/smoke.ps1
```

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 首页（服务端渲染） |
| GET | `/f/{id}` | 文件详情页 |
| PUT | `/api/v1/files?name=&mime=&hash=` | 流式上传，`hash` 可选（声明哈希做完整性校验） |
| POST | `/api/v1/files/claim` | 秒传：`{name, hash, size, mime?}` |
| GET | `/api/v1/files` | 文件列表（JSON） |
| GET | `/api/v1/files/{id}/download` | 302 到短时签名地址（字节由 nginx 直出） |
| DELETE | `/api/v1/files/{id}` | 软删除；引用归零后回收物理内容 |
| GET/POST | `/api/v1/posts` | 帖子列表 / 发帖 |
| GET | `/healthz`、`/readyz` | 存活 / 就绪（就绪会真打数据库与存储） |

## 目录

```text
site/                       ← git 仓库
├── crates/                 Rust workspace（core / storage / db / web / app）
├── migrations/             SQL 迁移（编译期内嵌进二进制）
├── deploy/                 nginx / systemd / sysctl / install.sh
├── docs/                   TECH_STACK · ARCHITECTURE · DEPLOY · BUDGETS
├── scripts/                冒烟测试与体积预算检查
└── web/                    Vue 3 + TS + Vite 前端岛
```

仓库**外层**目录（`../`）放 SSH 私钥与生产环境变量，不属于任何 git 仓库；
仓库内只保留 [.env.example](.env.example) 模板。

## 文档

- [docs/TECH_STACK.md](docs/TECH_STACK.md) —— 选型与明确不采用的方案
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 传输路径、存储抽象、数据模型
- [docs/DEPLOY.md](docs/DEPLOY.md) —— 单机部署、systemd 加固、nginx 边缘职责
- [docs/BUDGETS.md](docs/BUDGETS.md) —— 内存 / 带宽 / 页面体积预算与检查方式
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 分支模型、PR 要求、开发环境

## 许可

MIT，版权方 **SuperQuail** —— 见 [LICENSE](LICENSE)。

## 分支模型

| 分支 | 角色 |
| --- | --- |
| [`main`](https://github.com/SuperQuail/sc2clud/tree/main) | 稳定线，**只接受 PR 合入** |
| [`dev`](https://github.com/SuperQuail/sc2clud/tree/dev) | 集成分支，日常开发落这里 |
| [`release`](https://github.com/SuperQuail/sc2clud/tree/release) | 发版快照，从 main 快进并打 tag |

```text
功能分支 ──PR──▶ dev ──PR──▶ main ──▶ release（打 tag）
```

改动请开 PR；CI（格式 / clippy / 单测 / 端到端冒烟 / 前端体积预算）必须全绿。
