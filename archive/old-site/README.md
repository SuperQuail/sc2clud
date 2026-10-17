# 老站（Rust + Vue）· 只读归档

> 2026-10-16 归档：旧站已被 `forum/`（Go + React）替代。这里是**只读快照**，不再修改、不参与构建与门禁。

| 项 | 值 |
|---|---|
| 原位置 | 仓库根 `site/`（**独立的 git 仓库**；外层 `.gitignore` 里的 `/site/` 就是为它写的） |
| 旧站 HEAD | `9dcc6fc74dd1`（分支 `dev-side`） |
| 旧站远端 | `origin https://github.com/Tang-Tian-dev/SC2clud.git`（与本仓同仓库、不同分支）、`oss https://github.com/SuperQuail/sc2clud.git` |
| 这份快照 | 旧站 `git ls-files` 的 270 个**跟踪文件**（不含 `target/`、`web/node_modules/`、也不含 `.git`） |
| 要旧站提交历史 | 去 `site/`（本机仍保留其 `.git`）或上面两个远端 —— 快照本身不带历史 |

## 里面是什么
- `crates/`：Rust 后端（旧站的 axum 一族）；
- `web/`：Vue 3 前端；
- `migrations/`：旧库迁移；`docs/`、`AGENTS.md`：旧站的开发文档与代理协议（含 §12「后端迁移到 Go」的计划 —— 本轮重构正是它的兑现）；
- `scripts/`、`deploy/`：旧站的运维脚本与部署。

## 为什么只留快照
新仓要保持「一眼能读完的工作面」：老站 270 个文件 + 它自己的 `.git` 若并进来会淹掉论坛的目录结构；旧站历史在它自己的仓库与远端上，不丢。
