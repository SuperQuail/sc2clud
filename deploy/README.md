# deploy/ —— 上线是一条命令

> 设计依据：`完全重构/上线设计.md` §2 P3、`完全重构/部署与开发流程.md`。
> 这里只讲**怎么用**和**为什么这么写**；每一条都对应服务器上能核验的事实。

## 1. 一条命令

```powershell
# 仓库根目录
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 dev       # 构建 + 装到 dev
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 dev -SkipBuild   # 用现成产物（仍会核对二进制不比源码旧）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 prod      # 构建 + 装到生产
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 promote   # 把 dev 正在跑的版本装到生产
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 rollback -Instance prod
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 status    # 只看，不动
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 sync      # 生产库只读快照 → dev
```

> **必须用 `-File`（文件方式）执行。** 用 `-Command` 内联调用时，命令串会被加上 UTF-8 BOM，
> 远端 bash 第一行会变成 `﻿set: command not found`。脚本里已经用 base64 传输规避了传输层的
> 编码问题，但外层参数里的 BOM 无法从脚本内部消除。

## 2. 一个产物，一套目录

一次部署只搬一个文件：

```
forum-<version>.tar.gz
├── bin/forum          # 本地交叉编译的 linux/amd64 静态二进制（-ldflags -X main.version=<version>）
├── web/dist/          # 前端产物 + VERSION（/healthz 报的 web_version 就是它）
└── VERSION            # 人读的制品身份
```

服务器上**两个实例同一套目录形状**（与已在跑的 `/srv/sc2clud-dev` 一致）：

```
/srv/sc2clud-dev/            /srv/sc2clud-prod/          ← prod 与 dev 只差一个后缀
├── releases/<version>/      ├── releases/<version>/     ← 每次部署解一个新目录，不可变
├── current -> releases/<v>  ├── current -> releases/<v> ← 回滚就是换这条软链
├── incoming/                ├── incoming/               ← 上传的制品
├── artifacts/               ├── artifacts/              ← 换过 current 之后归档的制品
├── backups/                 ├── backups/                ← 部署前的 pg_dump -Fc
└── data/images/             └── data/images/            ← 图片：**不在 release 里**，release 会被删
```

- **release 不可变**：同名 release 已存在时脚本直接拒绝（改个 `-Version`），
  否则「现在跑的是哪份代码」又会变成一个没人答得出来的问题。
- 只保留最近 3 个 release；回滚可能要用到的那一个绝不删。
- `data/` 不随 release 走：删 release 不该删用户的图片。

## 3. 配置：/etc/sc2clud/<instance>.env

```
/etc/sc2clud/dev.env    600   FORUM_HTTP__ADDR=127.0.0.1:8082  DSN=…/forum_dev  cookie=forum_dev_session
/etc/sc2clud/prod.env   600   FORUM_HTTP__ADDR=127.0.0.1:8080  DSN=…/forum     cookie=forum_session
```

- 模板与全部键名：`secrets/env/production.env.example`（**密钥只在这里，不进仓库**）。
- 键名规则（`forum/internal/config/load.go`）：`FORUM_` 前缀、`__` 开一层、单个 `_` 属于字段名。
  `FORUM_KV__ADDR` → `kv.addr`；写成 `FORUM_KV__REDIS__ADDR` 会**静默读不到**（老的 dev.env 就是这么写的，
  所以 Redis 地址/口令一直用的是默认值 —— 本次已改正）。
- 没有配置文件：env 文件 + `forum/internal/config/defaults.go` 的内置默认值就是全部。
- 实例名就是 systemd 实例名，也是 env 文件名：
  ```
  sc2clud@dev.service  ← EnvironmentFile=/etc/sc2clud/dev.env  ← WorkingDirectory=/srv/sc2clud-dev/current
  sc2clud@prod.service ← EnvironmentFile=/etc/sc2clud/prod.env ← WorkingDirectory=/srv/sc2clud-prod/current
  ```

## 4. systemd：一个模板，两个实例

`deploy/systemd/sc2clud@.service`，由部署脚本在每次安装 release 时同步到
`/etc/systemd/system/sc2clud@.service`（内容不同才写 + `daemon-reload`）。

- **两个实例的 unit 完全相同**，差异只在 env 文件里：没有第二个地方能让两边悄悄跑偏。
- **禁止 drop-in 覆盖 ExecStart**（旧站踩过：改完 unit 跑的还是旧二进制）。要改启动命令就改
  `deploy/systemd/sc2clud@.service`，然后重新部署。
- 资源边界照 `完全重构/性能与容量.md`：`MemoryHigh=400M` / `MemoryMax=448M` / `GOMEMLIMIT=380MiB`。
- dev 的「空闲 30 分钟自动停」**没有做**（见 §9）。

## 5. 部署顺序（脚本里写死，顺序本身就是设计）

| 步 | 做什么 | 失败会怎样 |
|---|---|---|
| 1 | 构建：`pnpm build` + `GOOS=linux go build`（服务端没有 node/go） | 停在这里，什么都不动 |
| 2 | 打包 + 算 sha256 | 停 |
| 3 | 预检：ssh、env 文件在不在、release 是否已存在、端口是否被别的进程占着、磁盘 ≥2G | 停 |
| 4 | 上传（base64 分块，不依赖 scp），服务端重算 sha256 比对 | 停 |
| 5 | 解包 → 校验（可执行位、`web/dist/index.html`、`VERSION`、tar 里没有绝对路径/..）→ **换 current** → 同步 unit | 停（此时还没停服务） |
| 6 | **备份数据库** `pg_dump -Fc` 到 `backups/pre-deploy-<version>-<ts>.dump` | 停（服务还在跑旧版本） |
| 7 | `systemctl stop` → `forum migrate` → `systemctl start` | 回滚 |
| 8 | 健康检查：`/healthz` 200、**运行版本 == 刚发布的版本**、首页 200、首屏 assets 200 | 回滚 |
| 9 | 打印结论（版本、health body、备份路径、耗时） | — |

- **制品在服务端不重新编译**，dev 验过的就是生产要跑的。
- `forum migrate` 打印 `migrate: ok, version=N`；脚本再把 `schema_migrations` 读出来打印一行。
  版本对不上 migrate 会非 0 退出，服务**不会**带着错 schema 起来（`forum run` 启动时还会再核一次）。
- 步骤 8 的版本核对是灭掉「改了没生效」那一类问题的关键：`/healthz` 报的是二进制里
  `-ldflags -X main.version` 注进去的版本，`web_version` 报的是磁盘上 `web/dist/VERSION`。

## 6. 回滚

触发方式两种，走的是同一段代码：

- 自动：步骤 7/8 任一步抛错 → 换回上一个 release → 重启 → 再探 `/healthz`；成功退出码 `3`，
  没得回滚退出码 `1`。
- 手动：`deploy.ps1 rollback -Instance prod [-Target <version>]`（不给 `-Target` 就取「最新的、不是
  current 的那个 release」）。

**数据库不回滚。** 迁移是单向的：代码退回去、库还停在新 schema 上，旧二进制会因为
`forum run` 的启动自检（版本不一致）拒绝启动。真要退 schema 只有一条路：

```
pg_restore --clean --if-exists -d <dsn> /srv/sc2clud-prod/backups/pre-deploy-<version>-<ts>.dump
```

脚本会把这条命令打印出来，但**不做**：restore 会连部署之后写入的数据一起丢掉，那是人的决定。

演练脚本：`deploy/drill-rollback.ps1`（把健康检查路径指到一个不存在的路径，制造一次真失败）。

## 7. 远端脚本为什么是 bash 文件

`deploy/remote/*.sh` 是跑在服务器上的那一半，由 PowerShell 把
`lib.sh` + 某个脚本一起 base64 之后 `bash -s` 进去。

- 三层引号（PowerShell → ssh → bash）里任何一层多一个引号都会变成一次线上事故；
  base64 把这个问题一次性消掉，同时也就**不需要 scp**。
- 秘密（DSN、Redis 口令）以 base64 的 `SC2CLUD_ENV_B64` 传入，落在 `/tmp` 的 600 文件里，
  **不出现在 argv、不出现在日志**。
- `db-sync.sh` 里有一道硬闸：目标实例是 prod 就直接退出 —— 「快照反向写生产」在这套工具里
  **没有代码路径**。

## 8. 服务器上现在有什么（2026-10-13 核实）

| 东西 | 状态 |
|---|---|
| `/srv/sc2clud-dev/bin/forum` + `dist/` | P3 之前的一次手工投放（无 releases/current 结构），被本次部署取代 |
| `sc2clud-dev.service`（旧 Rust 调试实例，127.0.0.1:8081） | **仍在跑**，nginx `/dev/` 指着它。P3 不碰它 |
| `sc2clud-placeholder.service`（python 占位页，8080） | 仍在跑。**prod 上线前要停掉它**，8080 才空得出来 |
| `sc2clud@dev.service`（本方案，127.0.0.1:8082） | 本次演练装上 |
| `/etc/sc2clud/{dev,prod}.env` | 已改成新的键名；dev 的旧文件备份为 `dev.env.bak-pre-p3-*` |
| nginx | **一个字都没改**（见 `nginx-sc2clud.md`） |

端口分配的理由：8080 = 生产（nginx 的 `upstream sc2clud_app`），8081 = 旧 Rust 调试实例
（nginx `/dev/`），8082 = 新的 dev。**为什么要 8082 而不是复用 8081**：`/dev/` 还指着旧实例，
而任务约束是「不许动 /dev/」——新 dev 换端口是唯一能同时满足两条的做法。

## 9. 已知没做的（写在前面，别猜）

| # | 事项 | 现状 |
|---|---|---|
| 1 | dev 实例「空闲 30 分钟自动停」 | **没做**（需要一个 systemd timer + 一条判定规则）。4G 机器上目前两个 Go 实例都在跑 |
| 2 | `data/` 的属主/权限 | 服务以 root 跑（与旧 unit 一致），没有专门的 `forum` 系统用户 |
| 3 | 生产数据快照进 dev 的**图片**目录 | `sync` 只同步数据库；`rsync` 图片目录没接 |
| 4 | `/assets/` 由 nginx 直出 | 现在由应用直出（`FORUM_WEB__SERVE_ASSETS=true`），少一次优化 |
| 5 | TLS / 证书 | 沿用服务器上已有的 vhost，不在本方案范围内 |
| 6 | 生产上线 | **没做**。演练只到 dev |
