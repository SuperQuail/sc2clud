# deploy/migrate —— 老 Rust 站生产数据 -> 新 Postgres 的一次性导入

放在 `deploy/` 而不是 `forum/cmd/` 的理由：它**不是新站的运行时子命令**，只跑一次，
跑完就该删；放进 `forum/cmd/` 会被当成常驻命令维护，还要为它养一套配置加载。
它读的输入是裸 SQLite 文件，跑的位置是迁移者的机器，产物是一段 SQL —— 与部署脚本同族。

## 用法

```bash
# 1) 只看计划：打印「将写入 N 行」+ 对不上的字段/丢掉的表（不生成 SQL）
python deploy/migrate/import_legacy.py --dry-run

# 2) 看完整对应表（JSON，给报告用）
python deploy/migrate/import_legacy.py --report

# 3) 生成 SQL 并灌进 forum_dev（先看一遍再灌）
python deploy/migrate/import_legacy.py --emit > /tmp/import.sql
scp /tmp/import.sql root@HOST:/tmp/
ssh root@HOST "PGPASSWORD=... psql -h 127.0.0.1 -U forum -d forum_dev -v ON_ERROR_STOP=1 -f /tmp/import.sql"
```

## 三条性质

* **幂等**：public_id 由 `uuid5(NS_URL, "sc2clud-legacy:<table>:<id>")` 定死，
  每条 INSERT 先按确定性 uuid 查已有行，查到就跳过。重跑 N 次结果一样。
* **dry-run**：`--dry-run` 只统计，不生成 SQL、不连库。
* **不静默丢**：每一个被丢弃的表、每一列被改写的值都记在 `--report` 的
  `dropped` / `conflicts` 里，并有 `--dry-run` 的人话清单。

## 渲染

`content_html` / `excerpt` 走 `render/`（`go run ./deploy/migrate/render`），
调的是仓库里同一个 `platform/markdown` + `search.PlainText` —— 不手写第二套 Markdown。
没有 Go 工具链时脚本会**拒绝出 SQL**（不静默降级成 `<p>原文</p>`）。
