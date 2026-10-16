# PostgreSQL 选型核实（task-4）

核实时间 2026-10-12；工作区 `D:\Code\Rust\SC2clud`。
方法：① `go list -m -json <mod>@latest`（Go 1.27.2 windows/amd64，GOPROXY=`https://goproxy.cn,direct`）；② 直接读 Go 模块缓存源码（`C:\Users\ROG\go\pkg\mod\...`）；③ 官方文档原文（atlasgo.io / postgresql.org）。
本机现状（实测，非假设）：**没有** PostgreSQL、psql、pg_dump（`Get-Command psql,pg_dump,pg_restore,atlas` 全部无结果）；有 `docker.exe` 但守护进程未启动（`docker info` 报 `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`）。因此第 8/9 条属文档+源码核实，**未在实机 PG 上验证**。
每条格式：结论 → 证据 → 影响。

## 0. 版本快照

证据 = `go list -m -json <mod>@latest` 输出（Version/Time/GoVersion 字段）。

| 模块 | @latest | 发布时间(UTC) | 模块 go 指令 |
|---|---|---|---|
| github.com/jackc/pgx/v5 | **v5.11.0** | 2026-09-07T23:39:32Z | go1.25.0 |
| entgo.io/ent | **v0.14.6** | 2026-03-17T21:25:42Z | go1.24 |
| github.com/golang-migrate/migrate/v4 | **v4.20.1** | 2026-09-09T04:57:20Z | go1.25.11 |
| github.com/fergusstrange/embedded-postgres | **v1.34.0** | 2026-03-17T23:51:44Z | go1.18 |
| github.com/testcontainers/testcontainers-go | **v0.44.0** | 2026-08-07T10:52:31Z | go1.25.0 |
| ariga.io/atlas（库） | v1.3.0 | 2026-07-29T06:36:44Z | go1.26.4 |
| github.com/go-ego/gse | v1.1.0 | 2026-09-12T13:40:07Z | go1.24 |

- Atlas CLI 最新 release = **v1.3.0**（`api.github.com/repos/ariga/atlas/releases/latest` → `html_url: .../releases/tag/v1.3.0`）。注意 `ariga.io/atlas/cmd/atlas@latest` 仍是 2023 年的 v0.13.1，**不能用它当 CLI 版本**。
- 项目侧：`forum/go.mod` 是 `module forum` / `go 1.27`，已冻结 ent v0.14.6、migrate v4.20.1、gse v1.1.0、modernc.org/sqlite v1.60.1；**尚未列 pgx**。
- PostgreSQL 服务端版本（`postgresql.org/versions.json`）：18 为 current（latestMinor=6），14/15/16/17/18 supported；**13 已 EOL（2025-11-13）**。
- 影响：pgx v5.11.0 要求 go ≥ 1.25，项目 go 1.27 满足，可直接 `go get github.com/jackc/pgx/v5@v5.11.0`；生产目标定 PG 16/17/18，别定 13。

## 1. pgx 最新版 + ent 的 PG 驱动接法

**结论：用 `entsql.OpenDB(dialect.Postgres, sqldb)`，sqldb 由 pgx 的 stdlib 打开。不要用 `ent.Open("postgres", dsn)`。**

证据：
- `ent@v0.14.6/dialect/sql/driver.go:30-37`：`Open(dialect, source)` 内部就是 `sql.Open(dialect, source)` —— dialect 名同时当 database/sql 驱动名用。
- `ent@v0.14.6/dialect/dialect.go:19-21`：`Postgres = "postgres"`，但没有名为 "postgres" 的 pgx 驱动。
- `pgx/v5@v5.11.0/stdlib/sql.go:108-118`：pgx stdlib 注册的驱动名是 `"pgx"` 和 `"pgx/v5"`（`sql.Register`），不是 "postgres"。名 "postgres" 是 lib/pq 的。
- `driver.go:39-42`：`OpenDB(dialect string, db *sql.DB) *Driver` —— 官方给"用别的 driver"留的正路。
- `stdlib/sql.go:241` `OpenDB(config pgx.ConnConfig, opts ...OptionOpenDB) *sql.DB`；`:250` `OpenDBFromPool(pool *pgxpool.Pool, ...) *sql.DB`（想复用 pgxpool 时用后者）。

可直接抄的骨架（`internal/platform/db/open.go`）：
```go
import (
    "entgo.io/ent/dialect"
    entsql "entgo.io/ent/dialect/sql"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/jackc/pgx/v5/stdlib"
)

func openOne(dsn string, maxConns int32) (*ent.Client, *sql.DB, *pgxpool.Pool, error) {
    cfg, err := pgxpool.ParseConfig(dsn)      // dsn: postgres://user:pass@host:5432/forum?sslmode=disable
    if err != nil { return nil, nil, nil, err }
    cfg.MaxConns = maxConns
    pool, err := pgxpool.NewWithConfig(ctx, cfg)
    if err != nil { return nil, nil, nil, err }
    sqldb := stdlib.OpenDBFromPool(pool)      // database/sql 包装，ent 与 migrate 共用
    drv := entsql.OpenDB(dialect.Postgres, sqldb)
    return ent.NewClient(ent.Driver(drv)), sqldb, pool, nil
}
```
影响：现有"写池(1 连接)+只读池(mode=ro)"的形状可以保留（两个 pool 指向同一库，只读那个加 `default_transaction_read_only=on`），也可以直接合并成一个 pool——PG 不需要 SQLite 那种单写者约束。

## 2. ent `field.Enum` 在 PG 上实际生成的列类型

**结论：`varchar`。既不是 `CREATE TYPE ... AS ENUM`，也没有 CHECK 约束。**

证据：
- `ent@v0.14.6/dialect/sql/schema/postgres.go:141-144`（原注释）：`case field.TypeEnum: // Although atlas supports enum types, we keep backwards compatibility with previous versions of ent and use varchar (see cType).` → `schema.StringType{T: postgres.TypeVarChar}`。
- `ariga.io/atlas@v1.3.0/sql/postgres/driver.go:441`：`TypeVarChar = "varchar"`。对照 MySQL：`dialect/sql/schema/mysql.go:199-200` 才用 `schema.EnumType`。
- 全模块搜 `CHECK|CheckConstraint`：`dialect/sql/schema` 下只有 `mysql.go:96` 一句注释，**PG 路径不生成 CHECK**。
- 值校验只在 Go 层：`entc/gen/template/builder/create.tmpl:119-122` 与 `update.tmpl:257-260`（`$f.IsEnum` → 调生成的 Validator）。

影响：数据库不拦非法枚举值；手工 SQL、数据导入、别的语言写库都能写进脏值。要 DB 级约束必须手写迁移加 CHECK，并处理第 3 条的 Atlas diff 漂移。

## 3. ent 能不能声明 `lower(username)` 这类表达式唯一索引

**结论：不能。ent 的索引只能建在真实列上，没有"表达式索引"这个能力。**

证据：
- `ent@v0.14.6/dialect/sql/schema/schema.go:459-467`：`Index{Name, Unique, Columns []*Column, Annotation}` —— 只有列，没有表达式字段。
- `dialect/entsql/annotation.go:540-628`（`IndexAnnotation` 全部字段：Prefix/PrefixColumns/IncludeColumns/Type/Types/OpClass/OpClassColumns/Where/Desc/DescColumns）与 `:637-781` 的构造函数：没有任何 Expr 入口。（`IndexWhere` 只管部分索引的 WHERE，不管索引键表达式。）

三条绕法（按省事排序）：
1. **加一列规范化值**：应用层写入 `username_lower`，ent 里 `field.String("username_lower")` + `index.Fields("username_lower").Unique()`。全在 ent 内，Atlas 能管。
2. 手写迁移 `CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));`：能落地，但下次 `atlas migrate diff` 会计划 DROP INDEX（ent schema 里没它）。Atlas 库层支持跳过：`ariga.io/atlas@v1.3.0/sql/schema/migrate.go:336-372` `DiffSkipChanges(&DropSchema{}, &DropTable{}, &DropColumn{}, &DropIndex{}, &DropForeignKey{})`；CLI 的 `diff { skip { ... } }` 块确实存在，但文档只给了 drop_schema/drop_table 例子，**跳过 drop_index 的确切键名未确认**。
3. `citext` 类型：`field.String("username").SchemaType(map[string]string{dialect.Postgres: "citext"})`（`ent@v0.14.6/schema/field/field.go:334-343`）。citext 是 trusted 模块（postgresql.org/docs/current/citext.html 原文 "considered trusted ... installed by non-superusers who have CREATE privilege"），属主可自建。

影响：大小写不敏感唯一性要么多一列，要么手写迁移+处理 diff 漂移；别指望 ent 自动生成函数索引。

## 4. Atlas 生成 golang-migrate 格式迁移

**结论（命令写一行，PG）：**

```
atlas migrate diff <变更名> --dir "file://migrations/postgres?format=golang-migrate" --to "ent://internal/ent/schema" --dev-url "docker://postgres/17/dev?search_path=public"
```

证据：
- `dev-url` 的 PG 写法：`https://atlasgo.io/versioned/diff` 原文 `--dev-url "docker://postgres/15/dev?search_path=public"`；`https://atlasgo.io/skills/atlas/references/versioned.md` 给的是 `docker://postgres/17/dev?search_path=public`，并写明 `--to` 可接受 `file://schema.hcl | file://schema.sql | file://dir/ | ORM loader | 数据库 URL`，`--dir` 默认 `file://migrations`，`?format=` 用于其它工具布局。
- golang-migrate 格式：同一份参考原文 "Atlas can also write `golang-migrate`, `goose`, `flyway`, `liquibase`, `dbmate` layouts (`migration { format = golang-migrate }` in `atlas.hcl`, or `--dir "file://migrations?format=golang-migrate"`) ... but those formats are limited and many Atlas features are not available on them."；`atlasgo.io/guides/migration-tools/golang-migrate` 也有 `--url "file://migrations?format=golang-migrate"` 的实例。
- `atlas migrate hash` / `atlas migrate new` 参数同 `--dir`（方案 v2 6.x 的写法本身没错，只是 sqlite 换成 postgres）。

影响：`dev-url` 默认走 Docker；**本机 Docker 守护进程没跑**（`docker info` 失败），要么开 Docker Desktop，要么把 dev-url 换成本机 PG 实例（`postgres://user:pass@localhost:5432/atlas_dev?sslmode=disable&search_path=public`，即第 6 条 embedded-postgres 起的那个）。M0 的"生成迁移"步骤多了一条 dev 库前置依赖，CI 同理。

## 5. golang-migrate 的 PostgreSQL 驱动

**结论：用 `github.com/golang-migrate/migrate/v4/database/pgx/v5`（包名 `pgx`，注册名 `pgx5`），`WithInstance(*sql.DB, *Config)` 与现在 sqlite 的写法同型。**

证据：
- `migrate/v4@v4.20.1/database/pgx/v5/pgx.go:3` `package pgx`；`:22-23` `"github.com/jackc/pgx/v5/pgconn"` + `_ "github.com/jackc/pgx/v5/stdlib"`；`:26-29` `database.Register("pgx5", &db)`；`:66` `func WithInstance(instance *sql.DB, config *Config) (database.Driver, error)`；`:150` URL 形式的 scheme 是 `pgx5://`。
- `Config` 字段：`MigrationsTable/DatabaseName/SchemaName/StatementTimeout/MigrationsTableQuoted/MultiStatementEnabled/MultiStatementMaxSize`（`:44-54`）；**config 不能是 nil**（`:39 ErrNilConfig`、`:67-69`）；`DatabaseName/SchemaName` 为空时自动查 `CURRENT_DATABASE()/CURRENT_SCHEMA()`（`:75-101`）。
- 另一个驱动 `database/postgres`（走 lib/pq）注册 `postgres`/`postgresql`（`postgres.go:21,26-27,132`）——用它就得把 lib/pq 拖进二进制，没必要。

```go
import pgxmigrate "github.com/golang-migrate/migrate/v4/database/pgx/v5"

drv, err := pgxmigrate.WithInstance(sqldb, &pgxmigrate.Config{})   // sqldb = stdlib.OpenDBFromPool 那个
m, err := migrate.NewWithDatabaseInstance("iofs://migrations", "pgx5", drv)
```
影响：迁移执行器只换 driver，`iofs` + embed 的加载方式不变；生产镜像不带 lib/pq。

## 6. 测试用 PG：三条路线

| 路线 | 事实 | 证据 |
|---|---|---|
| embedded-postgres **v1.34.0** | 不需 Docker/PG 安装；首次从 Maven 拉二进制；支持 windows/amd64；默认版本 V18=18.3.0，默认端口 5432、库/用户/口令都是 postgres、startTimeout 15s | `config.go:39,155-166`（`V18=18.3.0`…`V9=9.6.24`）；`version_strategy_test.go:52` `"windows/amd64": {windows, amd64}`；`remote_fetch.go:26` Maven 路径；`cache_locator.go:16-18` 缓存 `%USERPROFILE%\.embedded-postgres-go` |
| 本机 PG + 每次建临时库 | 要装 PostgreSQL（本机没有：`Get-Command psql,pg_dump,pg_restore` 无结果）；测试要自己写建库/清库，无现成封装 | 本机命令输出 |
| testcontainers-go v0.44.0 | 需要可用的 Docker 守护进程 | 本机 `docker info` 失败：`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified` |

补充实测（本机 HEAD 请求 `repo1.maven.org`，均 200，网络可达）：
- `embedded-postgres-binaries-windows-amd64/18.3.0` = 25,252,876 B（≈24.1 MB，即默认版本）
- `.../17.5.0` = 23,185,666 B；`.../16.9.0` = 22,889,307 B

**建议（2 核 2GB Windows 开发机）：embedded-postgres。** 理由：不装任何东西、不依赖 Docker；一次性下载 ~22–24 MB 已验证可达；`Start()/Stop()` 就是一次集成测试。注意三点：① 默认版本是 18.3.0，要显式 `DefaultConfig().Version(embeddedpostgres.V17)`（=17.5.0）与生产对齐；② 默认端口 5432 会跟别人冲突，测试里用 `.Port(<随机空闲端口>)`；③ 2 核机器 15s startTimeout 可能偏紧，必要时 `.StartTimeout(60*time.Second)`（`config.go:130-133`）。

## 7. `SELECT ... FOR UPDATE SKIP LOCKED` 领取任务

标准写法（单语句，最省事）：
```sql
UPDATE tasks SET status = 'running', claimed_at = now(), worker = $1
WHERE id = (
  SELECT id FROM tasks
  WHERE status = 'pending'
  ORDER BY id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```
批量版把内层换成 `WITH next AS (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT $2)` 再 `UPDATE tasks t SET ... FROM next WHERE t.id = next.id RETURNING t.*`。

证据（官方文档原文）：
- `postgresql.org/docs/current/sql-select.html`：语法 `[ FOR { UPDATE | NO KEY UPDATE | SHARE | KEY SHARE } [ OF ... ] [ NOWAIT | SKIP LOCKED ] ]`；"Skipping locked rows provides an inconsistent view of the data, so this is not suitable for general purpose work, but **can be used to avoid lock contention with multiple consumers accessing a queue-like table**."
- `.../sql-update.html`：`UPDATE ... [ FROM from_item ] ... [ RETURNING ... ]`（恢复子句按此写）。

ent 侧（ent@v0.14.6 源码）：
- 要开 feature flag：`entc/gen/feature.go:108-114` `FeatureLock{Name:"sql/lock", Stage:Experimental, Default:false}`；生成入口 `entc.FeatureNames("sql/lock")`。
- 生成的方法：`entc/gen/template/dialect/sql/feature/lock.tmpl:17-45`，query builder 上 `ForUpdate(opts ...sql.LockOption) *XxxQuery` / `ForShare(...)`；PG 方言下会先 `Unique(false)`（:25-27，避免 DISTINCT 与 FOR UPDATE 打架）。
- 常量：`dialect/sql/builder.go:2301-2305` `NoWait/SkipLocked`，`:2336-2361` `WithLockAction/WithLockTables/WithLockClause`；生成的 SQL 断言见 `dialect/sql/builder_test.go:1759-1764`（`... FOR UPDATE OF "pets" SKIP LOCKED`）。

```go
tx, _ := client.Tx(ctx)                                   // SKIP LOCKED 必须在事务里
t, err := tx.Task.Query().
    Where(task.StatusEQ(task.StatusPending)).
    Order(ent.Asc(task.FieldID)).
    Limit(1).
    ForUpdate(sql.WithLockAction(sql.SkipLocked)).        // 需 sql/lock feature
    Only(ctx)
if ent.IsNotFound(err) { /* 队列空 */ }
_, err = tx.Task.UpdateOneID(t.ID).SetStatus(task.StatusRunning).Save(ctx)
tx.Commit()
```
影响：sqlq 的 PG 实现照这个写；开 `sql/lock` 会改动全部生成代码，建议在 M0 就打开（SQLite 不支持的顾虑已不存在）。

## 8. 中文检索

**(a) pg_trgm 在 PG 13+ 是 trusted。** 证据：`postgresql.org/docs/13/pgtrgm.html` 与 `/docs/current/pgtrgm.html` 同一句原文："This module is considered "trusted", that is, it can be installed by non-superusers who have CREATE privilege on the current database." → 库属主（有 CREATE 权限，且扩展文件已装，Linux 上通常是 postgresql-contrib 包）可自行 `CREATE EXTENSION pg_trgm;`，不需要超级用户。顺带核实 `citext` 同样 trusted（`/docs/current/citext.html` 同句）。

**(b) 生成列里能不能用 `to_tsvector`：只能用 2 参形式。**
- 生成列限制：`/docs/current/ddl-generated-columns.html` 原文 "The generation expression can only use immutable functions and cannot use subqueries or reference anything other than the current row in any way."
- 索引表达式同样要求 immutable：`/docs/current/sql-createindex.html` "All functions and operators used in an index definition must be "immutable"".
- 哪些 to_tsvector 能用：`/docs/current/textsearch-tables.html`（12.2.2 Creating Indexes）"Notice that the 2-argument version of to_tsvector is used. **Only text search functions that specify a configuration name can be used in expression indexes** ... the index contents must be unaffected by `default_text_search_config`."
- 未确认：`to_tsvector(regconfig,text)` 的 `provolatile='i'` 没有直接读到——`raw.githubusercontent.com/postgres/postgres/REL_17_STABLE/src/include/catalog/pg_proc.dat` 抓取被截断在 100 KB（文件 ~1.4 MB），结论是上面两条官方文档的交叉推论，不是 pg_proc 直读。

**(c) gse 预分词 + `to_tsvector('simple', ...)`：可行，但必须写"已分词"的那一列。**
- PG 默认 parser 把连续的非 ASCII 字母当同一个 word：`/docs/current/textsearch-parsers.html` "The parser's notion of a "letter" is determined by the database's locale setting, specifically lc_ctype"，token 类型表里 `word | Word, all letters | mañana`；源码 `src/backend/tsearch/wparser_def.c` 注释 "In C locale with a multibyte encoding, any non-ASCII symbol is considered an alpha character"（`p_iswhat(alpha, 1)`）。→ 未分词的一整句中文会是 **1 个 token**，检索不到词。
- 做法：写入时用 gse 切词 → 空格连接存 `search_text` 列 → `CREATE INDEX ... USING GIN (to_tsvector('simple', search_text))`；查询侧先 gse 切词再 `to_tsquery('simple', ...)`。
- 影响：检索依赖一个 ent 里的冗余文本列（ent 无生成列能力，见第 3 条同源限制），必须在同一个写事务里维护；两列不一致就会搜不到。
- 未确认：以上未在实机 PG 上跑 `ts_debug()` 验证（本机无 PG）。

## 9. uuid 与 timestamptz

- `field.UUID(...)` → PG `uuid`：`ent@v0.14.6/dialect/sql/schema/postgres.go:130-131` `case field.TypeUUID: t = &postgres.UUIDType{T: postgres.TypeUUID}`；`ariga.io/atlas@v1.3.0/sql/postgres/driver.go:500` `TypeUUID = "uuid"`。
- `field.Time(...)` → `timestamp with time zone`：`postgres.go:139-140` `case field.TypeTime: ... postgres.TypeTimestampWTZ`；`driver.go:477` `TypeTimestampWTZ = "timestamp with time zone"`。
- **默认值**：`field.Time("created_at").Default(time.Now)`、`field.UUID("id", uuid.UUID{}).Default(uuid.New)` **不会写进 DDL**。证据：`entc/gen/type.go:1573-1580` 只对 Numeric/Bool 与 String/Enum 常量赋 `c.Default`，Time/UUID 落到默认分支（值是 Go 侧 builder 填的）。
- 要数据库侧默认值：`entsql.Annotation{DefaultExpr: "now()"}` 或 `DefaultExprs`（`dialect/entsql/annotation.go:314-345`；`type.go:1583-1595` 用注解覆盖列默认值）。

影响：id/created_at 仍由 Go 生成默认值；一旦有第二写入方（脚本、导入、别的服务）必须显式给 DDL 默认值（`DefaultExpr`），否则 NOT NULL 直接报错。`optional` 字段在 PG 才是真 NULL，别把 SQLite 的隐性行为带过来。

## 10. pg_dump / pg_restore 备份与"单库快照恢复到测试库"

- 备份（custom 格式，压缩、可选择性恢复）：`pg_dump -Fc -d forum -f forum-20261012.dump`。证据 `/docs/current/app-pgdump.html`：`-Fc` = custom，"Together with the directory output format, this is the most flexible output format ... compressed by default"。
- 恢复到测试库（官方给出的两步）：`createdb -T template0 forum_test` 然后 `pg_restore -d forum_test --no-owner forum-20261012.dump`。证据 `/docs/current/app-pgrestore.html` 原文示例："To restore the dump into a new database called newdb: `createdb -T template0 newdb` / `pg_restore -d newdb db.dump` ... we clone the new database from template0 not template1, to ensure it is initially empty"。
- 需要覆盖同名库时：`pg_restore --clean -C -d postgres forum.dump`（`-C` 先建库、`--clean` 先 drop）。
- 工具版本：`pg_dump` 可以导比它旧的服务器，**不能**导比它新的（app-pgdump.html："pg_dump can also dump from PostgreSQL servers older than its own version ... However, pg_dump cannot dump f[rom newer]"）→ 客户端工具 ≥ 服务器版本。

影响：备份脚本从"cp 一个 .sqlite3 文件"改成 `pg_dump -Fc` + 保留 dump 文件；恢复演练就是在同一实例 `createdb -T template0 forum_test` 再 restore，不需要动生产库。

## 未确认清单（卡在哪说清楚）

1. `to_tsvector(regconfig,text)` 的 `provolatile` 直读证据：pg_proc.dat 抓取被截断到 100 KB；结论基于 PG 官方文档两条交叉（第 8 条）。
2. Atlas CLI `diff { skip { ... } }` 里"跳过 drop_index"的确切键名：只核实到库层 `DiffSkipChanges` 支持 `*DropIndex`；CLI 文档站点未列全（本机也没装 atlas，无法 `atlas migrate diff --help` 求证）。
3. embedded-postgres 在 Windows 上是否还需要额外运行时（如 VC++ Redistributable）：未验证，模块源码只体现 Maven 下载+解压。
4. 第 2/8/9 条的列类型与分词行为**未在实机 PostgreSQL 上验证**（本机无 PG、无 Docker 守护进程）。
5. Atlas CLI 版本/参数以官方文档为准，未用本机二进制验证（`atlas` 不在 PATH）。
