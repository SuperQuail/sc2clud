# D1 平台层与组装层设计

> 本文件由 Lead 直接写（原派的 agent 两次都没落盘，而 D1 是所有其它域的前置，不能再等）。
> 依据优先级：`后端开工前拍板.md` > `数据库设计-postgresql.md` §2/§6/§7/§9/§12 > `论坛后端技术方案-v2.md` §3/§4/§5/§7/§9.6/§13/§14。

## 0. 范围

| 包 | 职责 |
|---|---|
| internal/config | Config 结构体 + koanf 加载（默认值 → 文件 → 环境变量） |
| internal/platform/db | pgxpool → ent client；WithTx |
| internal/platform/apperr | 业务错误类型（code + status + fields） |
| internal/platform/httpx | 响应包络、绑定与校验错误、中间件、静态壳 |
| internal/platform/queue | Task/Queue/Worker 接口 + 类型常量；pgqueue 实现 |
| internal/platform/kv · ratelimit | Cache / RateLimiter 接口 + Redis 实现 |
| internal/platform/counter · clock · idgen · markdown | 计数缓冲、时间、ID、Markdown |
| internal/app | infra / modules / http / worker / cron / run / migrate / check / create-admin / backup |

## 1. 配置：internal/config

### 1.1 加载顺序（写死）

    默认值（结构体字面量） → configs/config.yaml（存在才读） → 环境变量（FORUM_ 前缀，双下划线层级）
    例：FORUM_DB__DSN → cfg.DB.DSN ；FORUM_HTTP__ADDR → cfg.HTTP.Addr

- **列表类配置不用环境变量覆盖**（env provider 表达不了数组，硬做会得到一个字符串）。
- 密钥类字段只从环境变量注入，不进 yaml。

### 1.2 字段与默认值（只列有默认值或必填的）

| 字段 | 默认 | 缺失时 |
|---|---|---|
| http.addr | 127.0.0.1:8081 | 用默认 |
| http.trusted_proxies | 空 = 不信任何代理 | 用默认；**非空时必须调 SetTrustedProxies**，否则 ClientIP 可伪造、限流失效 |
| http.cors.enabled | false | 用默认（默认同域，不开 CORS） |
| db.dsn | — | **拒绝启动** |
| db.max_conns | 16 | 用默认（2 核机器，数据库文档 §7） |
| queue.workers | 4（small）/ 8（standard） | 按 capacity.profile 取 |
| kv.addr | 127.0.0.1:6379 | 见 §13 未决问题 1 |
| mail.key（hex 32 字节） | — | **拒绝启动**（没有它解不开任何发信凭据） |
| image.root | — | **拒绝启动**，且启动时写一个 .probe 再删验证可写 |
| auth.session_ttl | 720h（30 天） | 用默认 |
| auth.argon2.* | time=2 / memory=32768 / threads=2 / key_len=32 | 用默认（v2 §9.1 钉死） |
| captcha.mode | off | 用默认（off / on_failure / always） |
| site.base_url | — | **拒绝启动**（域名白名单与发信回跳要用） |
| site.cookie_name | forum_session | 用默认；**dev/prod 同域部署必须不同**，否则两边会话互顶 |
| site.allowed_origins | 由 base_url 推导 | — |

### 1.3 校验

Validate() error 只做信任边界上的校验：必填非空、mail.key 是 64 个 hex 字符、env 属于 {dev,prod}、captcha.mode 属于三个已知值。
**不做「DSN 能不能连」这类探测**——那是 NewInfra 的事，失败也在那里报（启动即失败）。

## 2. 数据库：internal/platform/db

### 2.1 打开（参数照数据库文档 §7 写死）

    pc, err := pgxpool.ParseConfig(cfg.DSN)
    pc.MaxConns = 16 ; pc.MinConns = 2
    pc.MaxConnLifetime = time.Hour ; pc.MaxConnIdleTime = 30 * time.Minute
    pc.ConnConfig.RuntimeParams["timezone"] = "UTC"      // 会话级 UTC，不依赖服务端配置
    pc.ConnConfig.RuntimeParams["application_name"] = "forum"
    // 避免连接池上的准备语句爆炸：以本地 pgx 版本为准选 describe 模式（pgx.QueryExecModeDescribeExec）
    pool, err := pgxpool.NewWithConfig(ctx, pc)
    err = pool.Ping(ctx)                                  // 立刻 Ping：启动即失败，别等到第一个请求
    sqlDB := stdlib.OpenDBFromPool(pool)
    client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, sqlDB)))

- **只有一个池**（不再有读写双池）。
- **不要用 ent.Open("postgres", …)**：那条路要 lib/pq，而 pgx 的 stdlib 注册名是 pgx/v5。
- 关闭：先 client.Close() 再 pool.Close()。

### 2.2 WithTx

    func WithTx(ctx context.Context, c *ent.Client, fn func(tx *ent.Tx) error) error {
        tx, err := c.Tx(ctx)
        if err != nil { return err }
        defer func() { if p := recover(); p != nil { _ = tx.Rollback(); panic(p) } }()  // panic 也要回滚
        if err := fn(tx); err != nil { _ = tx.Rollback(); return err }
        return tx.Commit()
    }

**嵌套事务：不支持，也不模拟 savepoint。** 调用链只允许最外层开事务；service 内部若已在事务里，就把 *ent.Tx 传给私有辅助函数，不要重复调 WithTx。
理由：savepoint 让「回滚到哪一层」变成每处都要想的事，本项目没有需要它的场景。

**事务纪律（硬规则）**：事务里只做数据库读写 + EnqueueTx。
**禁止**在事务里发 HTTP、发邮件、写图片文件、调 Queue.Enqueue（后者会开第二条连接，还可能死锁）。
## 3. 错误：internal/platform/apperr

    type Error struct {
        Code   string            // 契约码，见 v2 §21.4；handler 不许自己造
        Status int
        Msg    string            // 给用户看的中文
        Fields map[string]string // 仅 common.invalid_input
    }
    func (e *Error) Error() string
    func New(code string, status int, msg string) *Error
    func Invalid(fields map[string]string) *Error    // code=common.invalid_input, status=400

已定义错误变量（与 §21.4 一一对应，**新增必须同时加进总表**）：

    ErrUnauthorized    = New("common.unauthorized", 401, "请先登录")
    ErrForbidden       = New("common.forbidden", 403, "没有权限")
    ErrNotFound        = New("common.not_found", 404, "内容不存在")
    ErrConflict        = New("common.conflict", 409, "数据已变化，请刷新")
    ErrRateLimited     = New("common.rate_limited", 429, "操作太频繁")
    ErrInternal        = New("common.internal", 500, "服务器错误")
    ErrEmailUnverified = New("auth.email_unverified", 403, "请先验证邮箱")

**分层**：service 返回 *apperr.Error；platform 返回包了上下文的原始错误（fmt.Errorf("…: %w", err)），
**platform 不 import apperr**（那是业务概念）。handler 只调一次 httpx.Fail。

## 4. HTTP：internal/platform/httpx

### 4.1 响应形状（严格照 v2 §21.1）

    成功对象：{ "data": { … } }
    成功列表：{ "data": [ … ], "next_cursor": "…" | null }
    失败：    { "error": { "code": "…", "message": "…", "request_id": "…", "fields": {…}? } }

    func OK(c *gin.Context, v any)                          // 200
    func Created(c *gin.Context, v any)                     // 201
    func OKList(c *gin.Context, items any, next string)     // next 为空串时输出 null
    func NoContent(c *gin.Context)                          // 204
    func Fail(c *gin.Context, err error)

Fail 的判定顺序：

    1. errors.As(err, **apperr.Error) → 用它；
    2. errors.Is(err, context.Canceled) → 499，只记 Debug（客户端断开不是服务端故障）；
    3. 其它 → 500 common.internal，细节只进日志（带 request_id），响应里不暴露。

### 4.2 绑定与校验

    func Bind(c *gin.Context, dst any) error   // ShouldBindJSON + validator 错误 → apperr.Invalid(fields)

- fields 的 key 用 **JSON 字段名**（前端要拿它 setError 到具体输入框）。
- validator 消息翻译成中文，集中在**一张 map** 里（required→不能为空、max→太长…）；不做 i18n 框架。
- **请求体上限按路由设**（http.MaxBytesReader）：默认 1MB、头像 128KB、帖子配图 3MB、收款码 768KB。
  用 httpx.BodyLimit(n) 挂具体路由，**不要全局一刀切**。

### 4.3 中间件顺序（写死）

    requestid → accesslog → recover → LoadPrincipal → ratelimit（按路由挂）→ Perm(...) → handler

| 中间件 | 做什么 | 不做什么 |
|---|---|---|
| requestid | 生成/透传 X-Request-ID，塞进 context 与 gin | — |
| accesslog | 方法/路径/状态/耗时/ip/user；跳过 /healthz /readyz | 不打印 query 串 |
| recover | panic → 500 + 日志（含堆栈） | 不把 panic 内容给用户 |
| LoadPrincipal | 只把凭证变成 Principal（见 D2） | 不判权限、不因未登录报错 |
| ratelimit | 按 key 限流，超限 429 + Retry-After | Redis 故障时**拒绝放行**（§5.2） |
| Perm | 全局权限点（AND；PermAny 为 OR） | **不判作用域权限**（要查库，留 service） |

### 4.4 引擎与服务器

    gin.SetMode(gin.ReleaseMode)   // 仅 env=prod
    r := gin.New()                  // 不用 gin.Default()：它自带 Logger/Recovery，与本设计重复
    r.SetTrustedProxies(cfg.HTTP.TrustedProxies)     // 必须调
    srv := &http.Server{ReadHeaderTimeout: 5s, ReadTimeout: 15s, WriteTimeout: 30s, IdleTimeout: 60s, MaxHeaderBytes: 1 << 20}

**探针**：GET /healthz（进程活着 + version）、GET /readyz（**真打一次库 + 图片根可写**）。
两个都**不带 /api/v1 前缀、不挂 LoadPrincipal**。

**静态壳**：生产由 nginx 直出 web/dist，Go 只出 HTML 文档（meta 壳）与 /api/v1；开发期可 Go 托管。
把现在 cmd/forum/main.go 里那套 SPA 壳收进 app 的一个 shell 组件，**保留它已有的两条正确行为**：
  ① 带扩展名的缺失资源直接 404（不回退 index.html，否则裂图会掩盖真因）；
  ② 启动时校验 index.html 存在，缺了就拒绝启动。
## 5. Redis：kv / ratelimit

### 5.1 接口（照 v2 §7.2 写死）

    // internal/platform/kv
    var ErrNotFound = errors.New("kv: not found")
    type Cache interface {
        Get(ctx context.Context, key string) ([]byte, error)                       // 未命中 → ErrNotFound
        Set(ctx context.Context, key string, val []byte, ttl time.Duration) error  // ttl 必须 > 0
        Del(ctx context.Context, keys ...string) error
    }

    // internal/platform/ratelimit
    type RateLimiter interface {
        Allow(ctx context.Context, key string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error)
    }

- key 前缀格式 模块:用途:标识（auth:login:ip:<ip>、captcha:<id>）；**前缀常量在各模块**，platform 不认识业务。
- 值统一 []byte，JSON 由调用方负责；接口里不出现任何具体实现类型。

### 5.2 Redis 实现与降级（行为必须明确）

| 用途 | Redis 挂了怎么办 | 为什么 |
|---|---|---|
| kv.Cache | 降级为直查数据库（Get 返回 ErrNotFound，调用方回源） | 缓存丢了没关系 |
| ratelimit | **拒绝放行**（返回 err → 中间件出 429） | 安全优先：宁可挡住，也不放行刷子 |

限流用**固定窗口 + Lua**（一次往返完成 INCR + 首次 EXPIRE + 取 TTL）：

    -- KEYS[1]=key, ARGV[1]=limit, ARGV[2]=window_seconds
    local n = redis.call('INCR', KEYS[1])
    if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
    local ttl = redis.call('TTL', KEYS[1])
    if n > tonumber(ARGV[1]) then return {0, ttl} end
    return {1, ttl}

固定窗口而不是滑动窗口：实现小、语义够用（登录 10 次/分钟这种），不需要额外存储。**不引 x/time/rate**（v2 §2 明令）。

## 6. 队列：internal/platform/queue + pgqueue

### 6.1 表（手写迁移 0015_queue）

    CREATE TABLE jobs (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      type         text        NOT NULL,
      payload      jsonb       NOT NULL,
      unique_key   text        NOT NULL DEFAULT '',
      status       text        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','dead')),
      priority     int         NOT NULL DEFAULT 0,
      attempts     int         NOT NULL DEFAULT 0,
      max_retry    int         NOT NULL DEFAULT 5,
      run_at       timestamptz NOT NULL DEFAULT now(),
      locked_until timestamptz,
      last_error   text        NOT NULL DEFAULT '',
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    -- [手写] 必须是**部分**唯一索引：普通唯一索引会让任务 done 之后永远无法再次入队
    CREATE UNIQUE INDEX uq_jobs_unique_key ON jobs (unique_key)
      WHERE unique_key <> '' AND status IN ('pending','running');
    CREATE INDEX idx_jobs_claim   ON jobs (priority DESC, run_at, id) WHERE status = 'pending';
    CREATE INDEX idx_jobs_recover ON jobs (locked_until) WHERE status = 'running';
    CREATE INDEX idx_jobs_cleanup ON jobs (status, updated_at);

### 6.2 领取：一条语句 + FOR UPDATE SKIP LOCKED

    UPDATE jobs SET status = 'running',
                    locked_until = $1,        -- clock: now + 5min
                    attempts = attempts + 1,
                    updated_at = $1
     WHERE id = (
             SELECT id FROM jobs
              WHERE status = 'pending' AND run_at <= $1
              ORDER BY priority DESC, run_at, id
              LIMIT 1
              FOR UPDATE SKIP LOCKED
           )
    RETURNING id, type, payload, attempts, max_retry;

- 吃 idx_jobs_claim（部分索引，只含 pending 行）；子查询 ORDER BY 与索引列序一致，LIMIT 1 让排序只走索引前几行。
- SKIP LOCKED 让 N 个 worker 并发领取互不阻塞——这就是「一条语句领一条，不需要先查再条件更新」的原因。

### 6.3 入队 EnqueueTx（与业务同事务）

    INSERT INTO jobs (type, payload, unique_key, priority, run_at, max_retry)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (unique_key) WHERE unique_key <> '' AND status IN ('pending','running') DO NOTHING;

- **冲突必须静默跳过**：不能因为去重把业务事务回滚。
- 空 unique_key 不参与去重（被部分索引的谓词排除）。
- EnqueueTx 收 *ent.Tx；Enqueue（非 Tx）只在确实没有业务事务时用（例如 cron）。

### 6.4 成功 / 失败 / 恢复 / 清理

    成功:  status='done', updated_at=$now
    失败:  attempts < max_retry → status='pending', run_at = $now + LEAST(10s * 2^attempts, 1h), last_error=$msg
           attempts >= max_retry 或返回 queue.ErrSkipRetry → status='dead'
    恢复:  每分钟  UPDATE jobs SET status='pending', locked_until=NULL
                      WHERE status='running' AND locked_until < $now
    清理:  每小时  DELETE ... WHERE status='done' AND updated_at < $now - 7d
                    DELETE ... WHERE status='dead' AND updated_at < $now - 30d

### 6.5 Worker

    type Handler func(ctx context.Context, payload []byte) error
    type Worker interface {
        Handle(taskType string, h Handler)
        Run(ctx context.Context) error   // ctx 取消后等在途任务结束再返回
    }

- 轮询 1 秒；Enqueue 成功后往带缓冲 channel 发信号立即唤醒；空轮询只记 Debug。
- 并发 = queue.workers（small 4 / standard 8）。
- **未注册类型的任务**：记 Error 并**直接置 dead**（不回队列）。类型常量是代码写死的，出现未知类型就是代码 bug，重试无意义。
- 处理函数 panic **必须 recover** 并按失败处理；处理函数**必须幂等**。

## 7. 计数：internal/platform/counter

    type Buffer struct { m map[string]int64; mu sync.Mutex; … }
    func (b *Buffer) Add(key string, delta int64)   // 内存累加
    func (b *Buffer) Run(ctx context.Context) error // 每 15s flush；ctx 取消时再 flush 一次才返回

- key 形如 view:topic:<id>、download:asset:<id>；**写回函数由 app 层注册**（counter 不认识业务表）。
- 写回是**一条批量 UPSERT**，不是每 key 一条：

      UPDATE topics SET view_count = view_count + v.d, updated_at = $1
        FROM (SELECT unnest($2::bigint[]) AS id, unnest($3::bigint[]) AS d) v
       WHERE topics.id = v.id;

- flush 失败**不清空缓冲**（下轮重试）并记 Warn；连续失败 3 次后丢弃该批并记 Error（避免内存无限涨）。
## 8. 迁移：编号规则与执行

### 8.1 目录与编号（所有域按这个走）

    forum/migrations/
      migrations.go                         # //go:embed postgres/*.sql
      postgres/
        0001_extensions     # pg_trgm 扩展
        0002_accounts       # users / sessions / email_tokens
        0003_authz          # roles / permissions / role_permissions / user_permissions / audit_logs / board_moderators
        0004_forum          # boards / board_acls / topics / posts / topic_sources / topic_images
        0005_forum_issue    # post_issues / issue_comments
        0006_social         # likes / bookmarks / blocks / reports / sanctions
        0007_notify         # notifications / notification_mutes
        0008_message        # messages
        0009_title          # titles / user_titles / exp_events
        0010_media          # images / default_avatars / payment_channels
        0011_reward         # donation_records / user_donation_settings / donation_notice_defaults
        0012_release        # releases / release_assets
        0013_site           # site_settings / site_domains / announcements / banners / banner_roles / banner_dismissals
        0014_mail           # mail_accounts / mail_quota / mail_logs
        0015_queue          # jobs
        0016_search         # topic_search + GIN
        0017_seed_authz     # 4 个内置角色 + 23 个权限点 + 角色×权限矩阵（数据）

- 命名：<4 位序号>_<域>.up.sql / .down.sql。**已提交的迁移禁止修改，只能新增。**
- 手写迁移里必须显式写：CHECK、部分索引、lower() 表达式唯一索引、生成列、扩展。
- **不用 Atlas**：本机没有可用 dev 数据库与 CLI，atlas migrate diff 跑不起来。
  迁移由人写（受本设计约束、可执行、可 review），再由**「空库跑迁移 vs client.Schema.Create」两条 DDL 路径 diff** 的自检守住一致性（CI，见 §10）。
  **代价与方法写在这里，不假装用了 Atlas。**

### 8.2 执行（forum migrate）

- golang-migrate + database/pgx/v5（注册名 pgx5）+ //go:embed migrations/postgres。
- 失败即非 0 退出，并打印**是哪一份**失败。
- **forum run 启动时校验**：DB 的 schema_migrations 最新版本 == 嵌入集最新版本；不一致 → **拒绝启动**并提示先跑 forum migrate。

## 9. 组装与运行：internal/app

### 9.1 Infra

    type Infra struct {
        DB      *ent.Client
        Cache   kv.Cache
        Limiter ratelimit.RateLimiter
        Queue   queue.Queue
        Worker  queue.Worker
        Mail    mail.Sender
        Search  search.Searcher
        Images  image.Store
        Captcha captcha.Verifier
        Counter *counter.Buffer
        MD      *markdown.Renderer
        Clock   clock.Clock
        Log     *slog.Logger
        closers []func() error
    }

- 每个组件构造时把清理函数 append 进 closers；Close() **倒序**执行并用 errors.Join。
- 任何一步失败：先 Close() 已建的再返回错误（**启动即失败**，不要半死不活地起来）。
- **禁止全局变量、禁止在 init() 里初始化任何东西**。

### 9.2 forum run 的关闭顺序（写死）

    1. HTTP：停止接收新请求，等在途请求结束（15s 超时）
    2. Worker：等在途任务结束
    3. cron：等本轮任务结束（备份的临时文件要清掉）
    4. Counter：把内存计数 flush 进库
    5. 关数据库与 Redis

    用 errgroup：HTTP / Worker / cron / Counter 各一个 goroutine，另一个监听 ctx.Done 做 srv.Shutdown。
    取消源是 signal.NotifyContext(SIGINT, SIGTERM)。

### 9.3 子命令

| 命令 | 职责 | 失败语义 |
|---|---|---|
| forum run | 起 HTTP + worker + cron | 任一前置失败即退出非 0 |
| forum migrate | 执行迁移 | 失败退出非 0 |
| forum check | 真实依赖探测 + 自检（库/迁移版本/图片根/Redis + §10 的自检 SQL） | 有任一失败即非 0 |
| forum create-admin | 幂等：不存在则建、存在则提升为 superadmin 并重置口令 | 缺参数退出 2 |
| forum backup | 立刻 pg_dump -Fc 一份 | 磁盘不足时拒绝并记 Warn |

## 10. 自检落点（数据库文档 §12 的 11 条）

| # | 检查 | 落点 | 为什么 |
|---|---|---|---|
| 2 | 迁移版本一致 | **启动（拒绝启动）** | 版本不对会静默跑错 schema |
| 3 | 权限点常量 == permissions 表 | **启动**（表里少 → 拒绝；表里多 → Warn） | 代码不认识它就是一个永远不生效的勾 |
| 4 | 枚举值域 == CHECK | **启动**（读 pg_constraint 解析比对） | 两条真源必须一致 |
| 5 | 等级不变量 | forum check | 数据量小，没必要挡启动 |
| 1 | 外键索引检查 | CI + forum check | 空库跑不出问题 |
| 6 | 打赏状态机 | CI + forum check | 同上 |
| 7 | 多态孤儿行 | CI + forum check | 同上 |
| 8 | images.refcount 一致 | CI + forum check | 同上 |
| 9 | 迁移 vs ent schema snapshot | CI（建两个 schema 后 pg_dump -s diff） | 重 |
| 10 | 无重复索引 | CI | 重 |
| 11 | 慢查询闸门（EXPLAIN 无 Seq Scan） | CI | 需要数据量 |

**启动只放不查业务数据、常数级的三条（2/3/4）**——启动路径上不允许有随数据量变慢的查询。

## 11. 测试数据库（决定所有域怎么测）

- **已在本机实测通过**：embedded-postgres v1.34.0 能起（PostgreSQL 18.3 x64-windows），启动 → select version() → 关闭全通。
  → 测试用 embeddedpostgres，**端口必须显式改成随机**（默认 5432 会撞真库），RuntimePath/DataPath/BinariesPath 放临时目录。
- 一个测试进程**共享一个实例**（TestMain 里起、退出停）；每个用例 CREATE SCHEMA test_xxx; SET search_path TO test_xxx;，结束 DROP SCHEMA … CASCADE。
- 两种建表路径都要测：① 用例内 client.Schema.Create（快）；② **一组「空库 → 跑嵌入迁移」的测试**（保证迁移文件本身能用，只跑一次）。
- CI 有 Docker 时优先 service container；没有就退回 embedded-postgres（本项目已验证可用）。

## 12. 明确不做

| 不做 | 理由 |
|---|---|
| DI 容器（wire/fx/dig） | v2 §2 明令；手动组装，构造函数收接口返具体类型 |
| Atlas CLI 生成迁移 | 本机无 dev 库/CLI；用手写迁移 + 两条 DDL 路径 diff 代替（§8.1） |
| 嵌套事务 / savepoint | 没有需要它的场景（§2.2） |
| 通用 KV「模拟 Redis」大接口 | v2 §7 原则：按用途定义小接口 |
| xxxtest 契约测试套件 | 只有一个实现时是没用的脚手架（v2 §7.3） |
| 滑动窗口限流 | 固定窗口 + Lua 够用（§5.2） |
| pgbouncer | 单机单应用，多一层多一处故障 |

## 13. 未决问题（请 Lead 拍板）

1. **开发机上没有 Redis**：github.com/redis/go-redis/v9 不在 go.mod 里，且开发机未必有 redis-server。
   建议：kv.driver / ratelimit.driver 支持 redis 与 memory 两个值，**配置校验里禁止 production 用 memory**；memory 仅供本地测试与 CI。
2. capacity.profile（small/standard）的判定来源：读 cgroup 内存上限，还是在配置里写死？性能与容量.md 有档位表，实现时按它取。
