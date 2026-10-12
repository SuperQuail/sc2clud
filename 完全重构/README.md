# 完全重构 · 入口

新项目在这两个目录里；旧站在 `site/`，**只读，不再改**（但 git 历史与旧库保留）。

| 位置 | 内容 |
|---|---|
| `forum/` | Go 后端模块（Gin + Ent + SQLite），module 名 `forum` |
| `web/` | React 前端（Vite + TS），产物 `web/dist` |
| `完全重构/` | 设计与调查文档（本目录） |

## 文档

| 文档 | 作用 |
|---|---|
| [论坛后端技术方案-v2.md](论坛后端技术方案-v2.md) | 后端唯一依据；第 20 章是范围决策，第 21 章是前后端接口契约 |
| [施工计划.md](施工计划.md) | **唯一排期来源**：S0–S8 阶段、验收、并行策略、上线切换检查单、可砍清单 |
| [服务器清单与运维.md](服务器清单与运维.md) | 服务器上有什么、密钥在哪、怎么自检、运维纪律（改服务器前先看） |
| [部署与开发流程.md](部署与开发流程.md) | dev/prod 双实例、制品与版本核对、一个部署脚本、生产快照进 dev、前端出图规矩、CI |
| [性能与容量.md](性能与容量.md) | **容量唯一依据**：2C2G 同机跑 prod+dev 的真实内存账、代码级优化（bigram 取代词典）、cgroup 硬顶、PG 参数、启动自检 |
| [数据库设计-postgresql.md](数据库设计-postgresql.md) | **数据库唯一依据**：38 张表的完整设计、PG 类型/索引/约束约定、中文检索、队列、备份、旧站用户迁移、一致性自检 |
| [postgres-选型核实.md](postgres-选型核实.md) | PG 相关版本与事实核实（ent 接法、Atlas、embedded-postgres…），每条带出处 |
| [旧站用户表提取.md](旧站用户表提取.md) | 旧 users 表 34 列的事实清单（活列/死列、密码格式、角色来源），迁移映射的输入 |
| [前端架构设计-v1.md](前端架构设计-v1.md) | 前端唯一依据；技术栈冻结、目录与依赖方向、数据层、预算门禁 |
| [原项目功能清单.md](原项目功能清单.md) | 粗粒度功能对标：每条带证据路径与「新方案覆盖」档 |
| [原项目失败复盘.md](原项目失败复盘.md) | 12 条根因 + 反模式黑名单 + 遗留陷阱 + 10 条最小验收线 |

## 工具链

Go 装在工作区内（不改系统 PATH、不需要管理员）：

    .tools/go/bin/go.exe        # go1.27.2，由 .tools/install-go.ps1 安装
    node 24.19.0 / pnpm 11.21.0 # 系统已装

用 Go 之前：

    $env:PATH = "D:\Code\Rust\SC2clud\.tools\go\bin;" + $env:PATH
    $env:GOPROXY = "https://goproxy.cn,direct"

## 常用命令

    cd web; pnpm install
    cd web; pnpm check      # typecheck → lint → test → 体量门禁 → build → 体积门禁
    cd web; pnpm dev        # 5173，/api 代理到后端 8080

    cd forum; go build ./...

## 现状（2026-10-12）

- **前端**：F0 骨架完成，`pnpm check` 全绿；React 18.3.1 + react-router 7.18.4；控件基座 = Ring UI（built，核心）+ shadcn/ui（补充）+ Tailwind，图标 = lucide-react，只允许 `.ts`/`.tsx`。
  Ring UI 与 Tailwind 的共存性已实测（`web/tools/ring-ui-lab`）：必须用 `@jetbrains/ring-ui-built`。
  首屏 JS 108.9 KB（gzip），预算 150 KB。
- **数据库**：已定 PostgreSQL；表结构全部重新设计（含 users 表），旧站只迁用户。
- **后端**：`go.mod` 已按方案第 2 章钉死 20 个依赖并全部下载成功（版本与文档逐条一致），
  目前只有一个骨架 `cmd/forum/main.go`；**M0 尚未开始**（见后端方案第 17 章）。
  注意：M0 写代码之前不要跑 `go mod tidy`，它会把还没被 import 的依赖全删掉。
- **已定案（2026-10-12）**：PostgreSQL；网盘放弃；私信 / 头衔等级 / 资源帖 issue 进 v1；用户数据**完整迁移**（含头像、头衔、经验；配额随网盘放弃）；赞赏走**老设计**（作者收款码 + 用户自报 + 管理员人工核验，站点不经手资金）；前端不引入 Node 运行时；控件基座 Ring UI(built) + Tailwind；图标 lucide-react；只允许 `.ts`/`.tsx`。
- **仍待拍板**：后端方案第 20 章 D5/D6/D7、前端方案第 14 章 FQ2–FQ6、以及第 19 章 Q3/Q7/Q8/Q9 与数据库文档第 13 章 G1–G4/G6。

## 还没做的事

- 后端 M0（config / slog / db 读写双池 / WithTx / apperr / httpx / 中间件 / migrate / run / healthz）。
- nginx 与部署脚本（旧站的 `deploy/` 不复用）。
- 契约测试（后端方案 21.6）——旧站根因 6 的那道闸门。
