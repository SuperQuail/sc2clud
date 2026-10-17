# SC2clud 社区站（Go + React）

> 星际争霸战役作者社区：帖子 / 评论 / 用户 / 通知 / 资源下载 / 打赏 / 管理后台。
> 后端 Go（Gin + Ent + PostgreSQL），前端 React（Vite + TypeScript + Ring UI）。

## 目录

| 位置 | 内容 |
|---|---|
| `forum/` | Go 后端（`go build ./...`；测试 `go test ./internal/...`） |
| `web/` | React 前端（`pnpm install && pnpm check`；`pnpm dev` 起 5173） |
| `deploy/` | 部署脚本与远端步骤（`deploy.ps1 dev|prod` 由维护者执行） |
| `完全重构/` | 设计文档与账本：**入口 [`完全重构/README.md`](完全重构/README.md)**（现行契约留根，已完成的设计在 `说明/`，当期工作在 `进行中/`） |
| `archive/old-site/` | **老站（Rust + Vue）只读快照**，见 [`archive/old-site/README.md`](archive/old-site/README.md) |

## 分支

| 分支 | 内容 |
|---|---|
| `main` / `master` | 现行 Go + React 实现（两者同一提交） |
| `old-site-rust-vue` | 旧站（Rust + Vue）完整历史，只读 |

> **别和上游搞混**：老站的公开原始仓库是 [`SuperQuail/sc2clud`](https://github.com/SuperQuail/sc2clud)（只读参考，自 2026-10-12 起不再更新）；**本仓库 `Tang-Tian-dev/SC2clud`（私有）才是现行 Go + React 实现**，默认分支 `main`。

## 环境

- Go 装在仓库内：`.tools/go/bin/go.exe`（不改系统 PATH）；Node 22+ / pnpm 11。
- 数据库 PostgreSQL；本地跑测试需要嵌入式 PG（测试台自动起）。
