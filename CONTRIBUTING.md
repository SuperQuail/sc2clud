# 贡献指南

本项目采用 **MIT 许可**（见 `LICENSE`）。欢迎 issue 与 PR。

## 分支模型

| 分支 | 角色 | 规则 |
| --- | --- | --- |
| `main` | **稳定线**，公开可用的状态 | 只接受 PR 合入，不允许直接 push |
| `dev` | **集成分支**，日常开发都落在这里 | 功能分支从 `dev` 开，PR 回 `dev` |
| `release` | **发版快照** | 从 `main` 快进并打 tag，只做 cherry-pick 的热修 |

```text
功能分支 ──PR──▶ dev ──PR──▶ main ──▶ release（打 tag）
```

## 提 PR 的硬性要求

1. **目标分支**：日常改动 → `dev`；紧急热修 → `release` 或 `main`（需说明原因）。
2. **CI 必须全绿**（GitHub Actions 自动跑）：`cargo fmt --check`、
   `cargo clippy -D warnings`、`cargo test --workspace`、`bash scripts/smoke.sh`，
   以及前端岛的类型检查、构建与体积预算。
3. **本地先过一遍**（与 CI 等价，见 `AGENTS.md` §8）。
4. **描述写清楚**：改了什么、为什么、怎么验证；界面改动请附截图。
5. **不要提交密钥**：`.env`、SSH 私钥、任何生产口令都不进仓库（见 `AGENTS.md` §10）。

## 提交信息

沿用 Conventional Commits 风格，中文描述即可：

```text
feat(web): 帖子列表视图
fix(deploy): 升级时显式 restart 服务
docs: 补充分支模型
```

## 开发环境

```bash
cargo run -p sc2clud -- check              # 配置与依赖自检
cargo run -p sc2clud                       # 默认 serve，监听 127.0.0.1:8080
pnpm -C web install && pnpm -C web build   # 前端岛（产物进 static/islands）
```

本地开发时打开 `SC2CLUD_SERVE_BLOBS_LOCALLY=1` 让应用自己回图片字节（生产由 nginx 直出）；
调试页另开 `SC2CLUD_DEBUG_PAGES=1`，且只在回环监听时允许。
