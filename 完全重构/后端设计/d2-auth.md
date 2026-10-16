# D2 认证 / 会话 / RBAC 设计（auth·authz·user 模块 + 相关表）

> 域：D2。范围：`internal/auth/**`、`internal/authz/**`、`internal/user/**` + users / sessions / email_tokens / roles / permissions / role_permissions / user_permissions / audit_logs 八张表（+ board_moderators 的列与索引、users 里的头像列）。
> 真源优先级：**完全重构/后端开工前拍板.md**（下称「拍板」）> 数据库设计-postgresql.md §2/§3/§4 > 论坛后端技术方案-v2.md §9/§14/§21 > RBAC权限树设计.md。
> 本文件只写**能直接照着写代码**的东西。含糊的地方一律进 §17「未决问题」，不在这里拍。

---

## 0. 先回答「这段代码如果不写会少什么」

| 组件 | 不写会怎样 |
|---|---|
| argon2id + 信号量 | 密码明文或弱哈希落库；并发登录把 2GB 机器打爆（10×32MB 瞬时分配） |
| sessions + LoadPrincipal | 没有登录态；每个请求都要带凭据 |
| 60 秒缓存 | 每个请求多 1 次 JOIN + 1 次权限查询（列表页 P95 直接翻倍） |
| **permissions 表 + 常量 + 启动自检** | 权限点散在代码里，「谁能做什么」没人能回答；新端点忘加权限没人发现 |
| user_permissions | 临时给某人几条权限只能整包给角色 → 给完忘了收 → **降权做不到**（RBAC 文档 §0 的根因） |
| 最后一个 superadmin 守卫 | 管理员点一下就把自己锁在门外，只能改库救回来 |
| audit_logs | 提权、封号、导审计无痕迹；事后无从追查 |
| 等级/经验不变量 | users.level 与 exp 漂移，个人主页显示的数字是错的 |

**反过来，以下东西本设计刻意不做**（拍板 §0、§6）：不造 user_roles、不造 moderator 内置角色、不造 post_revisions、不做 sort=hot、不做 JWT、不做第二套权限缓存、不做「以后可能要」的权限抽象。

---

## 1. 一句话总纲

**一个用户 = 一个基线角色（users.role_id）∪ 若干条未过期的点对点追加（user_permissions）。**
会话是一行 sessions，凭据是 Cookie 里的 32 字节随机串，库里只存它的 SHA-256。鉴权只回答两个问题：「你是谁」（auth）与「你能不能」（authz），两者各写一次，业务模块不再各判各的。

---

## 2. 目录与文件（只列本域，路径相对 forum/）

    internal/authz/                 # 纯逻辑，不碰 DB、不碰 gin
    ├── permissions.go              # 25 个权限点常量 + Groups() 目录
    ├── set.go                      # Set 类型（map 背书）
    ├── actor.go                    # Actor 结构体、Require、CanInBoard、HasAny
    ├── errors.go                   # ErrForbidden（403 common.forbidden）
    └── set_test.go · actor_test.go

    internal/auth/                  # 注册/登录/会话/令牌/我的账号/提权写操作
    ├── service.go                  # Service、NewService、登录/注册/令牌/会话
    ├── password.go                 # argon2id 哈希/校验/rehash 判定 + 并发信号量
    ├── middleware.go               # LoadPrincipal、RequireLogin、RequireActivated、Perm、PermAny
    ├── principal.go                # Principal、ctxKey、FromGin、ClearCookie
    ├── privileges.go               # 角色/权限/追加/封号/审计（危险写操作，service 层再 Require 一次）
    ├── handler.go                  # Handler、Register
    ├── dto.go                      # 请求/响应体（契约真源）
    ├── deps.go                     # 本模块需要的外部能力小接口
    ├── touch.go                    # TouchAsync 节流 + 批量刷写 goroutine
    ├── cache.go                    # 会话/权限缓存的读写与失效（唯一入口）
    ├── pgsql/queries.go            # 原生 SQL：JOIN board_moderators、权限闭包（WITH RECURSIVE）
    ├── schema_check.go             # 启动自检：权限点/枚举/外键索引
    ├── errors.go
    └── *_test.go

    internal/user/                  # 公开资料（只读 + 搜索）
    ├── service.go · handler.go · dto.go · deps.go · errors.go
    ├── pgsql/queries.go            # 个人主页聚合 SQL
    └── service_test.go

    internal/ent/schema/
    ├── mixin/time.go               # created_at / updated_at（D1 提供，本域复用）
    ├── user.go · session.go · emailtoken.go
    ├── role.go · permission.go · rolepermission.go · userpermission.go
    └── auditlog.go

**为什么 authz 是独立包**：它是纯函数库（判定 + 常量），没有 DB、没有 gin、没有 service。任何模块都能 import 它而不会引入循环依赖。

**为什么 pgsql/ 子包**：开发必读 §1.8 与后端方案 §15.7 只允许原生 SQL 出现在 platform 层与手写迁移里。本域需要 3 条 ent 表达不了的 SQL（WITH RECURSIVE、JOIN 缓存外数据、多态审计筛选），集中在两个 pgsql 子包里。这不是新抽象层，是几个 const + 几个函数。

---

## 3. 不做清单（写在这里是为了以后不再讨论）

| 不做 | 理由 |
|---|---|
| JWT / access+refresh 双令牌 | 方案定死「不透明 token + Cookie + sessions 表」 |
| user_roles 多角色表 | 拍板 §1.4：单一基线角色 |
| moderator 内置角色 | 拍板 §1.3：作用域用 board_moderators |
| 独立的「角色→权限」缓存、第二份 Principal 缓存 | 缓存条目必须是**一个**含 status / BoardIDs / Perms 的整体，否则又是两份真源 |
| 后台新增权限点 | 方案 §9.8 禁止：代码不认识的勾永远不生效 |
| 邮箱验证后才能登录 | 与 20.2 第 22 条冲突，见 §17 U6（本设计按 20.2 第 22 条实现） |
| 密码历史 / 强度计 / 2FA / 设备指纹 | 没需求 |
| users 软删（status='deleted'）的注销流程 | 本域只定义状态值；注销端点未确认，见 §17 U16 |
| 往 users 加「以后可能用」的列 | 拍板 §0 |

---

## 4. 模块边界与 import 规则

    handler  →  service  →  ent client / platform / 本模块 pgsql 子包
                        ↘  其他业务模块（只通过 deps.go 的小接口，由 app 层注入）

本域**实际存在**的跨模块依赖只有 3 条，全部单向：

    user.Service   ← auth.Service      （登录/注册要读 users 行）
    auth.Service   ← 其它业务模块       （它们要读 actor 的 Perms / BoardIDs / EmailVerified）
    authz          ← 所有模块          （权限点常量 + 判定函数；无依赖）

- user 不 import auth、不 import authz（它只做读 + 公开页；写操作都在 auth）；
- auth 不 import user 的包，只 import 自己 deps.go 里定义的接口——app 层把 `*user.Service` 传进去。

### 4.1 职责切的依据：谁拥有 users 表

| 表 | 唯一写者 | 说明 |
|---|---|---|
| users | **auth** | 账号行（密码、状态、验证时间、昵称/简介、角色与等级列）。user 模块**只读** |
| sessions / email_tokens | auth | — |
| roles / permissions / role_permissions / user_permissions / audit_logs | auth（privileges.go） | 提权类写操作与审计的唯一入口 |
| board_moderators | **forum（D3）** | 表在论坛域；它的写操作要回调 auth.InvalidateUser（§8.5） |

**结论**：users 表只有一个写者（auth），不存在「两个模块写同一张表、字段互相覆盖」。user 模块是纯读模块，只有 3 个方法。这也是本域不拆更多模块的理由——拆了就要共享 users 的写，那是自找的并发 bug。

### 4.2 deps.go 形状

    // internal/auth/deps.go
    type UserLookup interface {
        GetAuthRow(ctx context.Context, login string) (*UserAuthRow, error)   // 登录/注册用
        GetBasic(ctx context.Context, userID int64) (UserBasic, error)
    }

    type KV interface {                                   // platform/kv.Cache 的子集
        GetInt64(ctx context.Context, key string) (int64, error)
        Incr(ctx context.Context, key string, ttl time.Duration) (int64, error)
        Get(ctx context.Context, key string) ([]byte, error)
        Set(ctx context.Context, key string, val []byte, ttl time.Duration) error
        Del(ctx context.Context, keys ...string) error
    }

    type Queue interface { EnqueueTx(ctx context.Context, tx *ent.Tx, task queue.Task) error }
    type Limiter interface { Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, time.Duration, error) }

    type UserAuthRow struct { /* §5.1 里登录判定需要的列，不含 Perms */ }
    type UserBasic struct{ ID int64; PublicID, Handle, Nickname, AvatarHash, AvatarSmallHash, Status string }

**注意**：UserAuthRow 里**没有** Perms——权限由 §8.3 那一条 SQL 单独算，不由 user 模块拼。

### 4.3 配置（只加不删）

    auth:
      argon2_memory_kb: 32768     # 32MB
      argon2_time: 2
      argon2_threads: 2
      argon2_max_concur: 2        # 并发哈希信号量容量
      argon2_wait_timeout: 3s     # 等不到信号量就 503
      session_ttl_hours: 720      # 30 天
      touch_interval: 10m         # 同一会话两次写 last_seen_at 的最小间隔
      renew_interval: 24h         # expires_at 真正的续期间隔
      cache_ttl: 60s
    server:
      cookie_name: forum_session  # 方案 §9.2；dev 与 prod 同域时必须不同名
    user:
      nickname_max: 20            # 按 rune 计
      profile_max: 200            # bio 按 rune 计

（Auth 结构体在方案 §13.3 的基础上补 4 项；cfg.Validate() 要校验 argon2_memory_kb ∈ [8192, 65536]、argon2_max_concur ∈ [1, 4]。）

---

## 5. 表设计

类型简写：ts = timestamptz。所有表 `created_at ts NOT NULL DEFAULT now()`，会变的表加 `updated_at ts NOT NULL DEFAULT now()`（由 ent mixin 在应用层写，**不建触发器**，数据库文档 §2.12）。

### 5.1 users

```sql
CREATE TABLE users (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           uuid        NOT NULL UNIQUE,
  username            varchar(32) NOT NULL,
  email               varchar(254) NOT NULL,
  password_hash       text        NOT NULL,
  nickname            varchar(20) NOT NULL,
  bio                 varchar(200) NOT NULL DEFAULT '',
  avatar_hash         char(64)    NULL REFERENCES images(hash) ON DELETE SET NULL,
  avatar_small_hash   char(64)    NULL REFERENCES images(hash) ON DELETE SET NULL,
  status              text        NOT NULL DEFAULT 'active'
                        CONSTRAINT ck_users_status CHECK (status IN ('active','banned','deleted')),
  email_verified_at   ts          NULL,
  activated_at        ts          NULL,
  trusted             boolean     NOT NULL DEFAULT false,
  role_id             bigint      NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  equipped_title_id   bigint      NULL REFERENCES titles(id) ON DELETE SET NULL,
  exp                 int         NOT NULL DEFAULT 0 CONSTRAINT ck_users_exp_nonneg CHECK (exp >= 0),
  level               int         NOT NULL DEFAULT 1 CONSTRAINT ck_users_level_min CHECK (level >= 1),
  default_avatar_hash char(64)    NULL REFERENCES images(hash) ON DELETE SET NULL,
  last_login_at       ts          NULL,
  created_at          ts          NOT NULL DEFAULT now(),
  updated_at          ts          NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX uq_users_email_lower    ON users (lower(email));
CREATE INDEX idx_users_created_at     ON users (created_at DESC, id DESC);  -- 后台列表游标
CREATE INDEX idx_users_role           ON users (role_id);                   -- FK：RESTRICT 也要扫
CREATE INDEX idx_users_avatar         ON users (avatar_hash);              -- 纯 FK 索引（SET NULL）
CREATE INDEX idx_users_avatar_small   ON users (avatar_small_hash);        -- 纯 FK 索引（SET NULL）
CREATE INDEX idx_users_equipped_title ON users (equipped_title_id);        -- 纯 FK 索引（SET NULL）
CREATE INDEX idx_users_default_avatar ON users (default_avatar_hash);      -- 纯 FK 索引（SET NULL）
```

**`default_avatar_hash` 是 2026-10-13 拍板新增的列**（拍板 §8.8 / U12）：它是旧站「分一次就固定」的落点，语义见 §10.7；为 NULL 时由读路径按 `users.id` 对池子大小取模，**首次分配后写回、此后不变**。本域只提供列与索引，"分配"发生在 media 的读写路径上。

**曾经加过、又被删掉的一列：`activation_pending`**（2026-10-13 用户定案，拍板 §12）。2026-10-12 的设计里它是 `users` 上的一列（`email` / `manual` / NULL），表达"这封验证信发出去了没有"。改成**由一个开关决定模式**之后它就没有存在理由了——**模式是全局配置，不是每个用户各自的状态**。所以：

- `users` **没有** `activation_pending` 列（迁移与 ent schema 里都已删除，拍板 §12.5 的回写清单有这一条）；
- 那个开关是 `site_settings` 的键 `auth.registration.auto_activate`（默认 `true`），读法与 30 秒缓存见 §10.1；
- 这条改动的"四问"（现象 / 根因 / 堵法 / 是否误操作）写在 §17.2。

**为什么头像列、equipped_title_id、default_avatar_hash 也有单列索引**（拍板 §5.9 第 6 条）：四个列都是外键，PG 删父行要扫子表（`role_id` 是 RESTRICT，其余是 SET NULL）。数据库文档 §12.1 的自检按 `pg_constraint` 扫，**没有排除名单**——所以这几条是「不加就红」的。它们是纯 FK 索引（没有查询用它们），代价是每次写 users 多维护几个 B 树：1 万用户量级下合计约 0.8MB，可以接受；真到十万用户再考虑改用「status <> 'deleted' 的部分索引 + 自检加例外」，那时候有数据可依。

**手写迁移专属**（ent 生成不了，Atlas diff 会想删）：

1. uq_users_username_lower / uq_users_email_lower：表达式唯一索引（数据库文档 §2.9）。**查询必须写 `lower(username) = lower($1)` 才走索引**——本设计里只有三处查 username：登录（§7.2）、GET /users/{handle}（§11.1）、handle 占用检查（§7.1）。别的地方不许再查 username。email 同理，只有登录与找回密码查。
2. ck_users_status / ck_users_exp_nonneg / ck_users_level_min：CHECK（ent 的 field.Enum 在 PG 上只生成 varchar）。
3. 大小写不同的重名注册由这个索引直接拒绝（返回 409 common.conflict）。

**不变量**：

- username 建后不可改（旧站语义）；没有改登录名的端点，DTO 里也没有这个字段。
- nickname 非空、允许重复；只在导入时旧 display_name 为空才回落到 username。
- exp 与 level 的公式见 §12；三根状态轴的判定见 §9.1。
- `status` 的 CHECK 里保留 `'deleted'`，但**注销端点本轮不做**（拍板 U16）：保留是为了以后加时不用改已上线的 CHECK。

### 5.2 sessions

```sql
CREATE TABLE sessions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     uuid        NOT NULL UNIQUE,
  token_hash    bytea       NOT NULL CONSTRAINT ck_sessions_hash_len CHECK (octet_length(token_hash) = 32),
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    varchar(64) NOT NULL,
  ip            inet        NOT NULL,
  user_agent    text        NOT NULL DEFAULT '',
  expires_at    ts          NOT NULL,
  last_seen_at  ts          NOT NULL DEFAULT now(),
  created_at    ts          NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_sessions_token    ON sessions (token_hash);
CREATE INDEX        idx_sessions_user    ON sessions (user_id);      -- FK：删用户级联
CREATE INDEX        idx_sessions_expires ON sessions (expires_at);   -- 过期清理 + FK
```

- **有 `public_id`**（拍板 U13，2026-10-13 定案）：`GET /me/sessions` 返回的 `id` 与 `DELETE /me/sessions/{id}` 收的都是它。本设计原来打算用「token_hash 的 base64url 前 16 字节」省一列，**被推翻**：对外 ID 一律走 `idgen.NewPublicID()`（拍板 §5.6），会话表不该是唯一的例外——对前端两者都是不透明串，但对「所有对外 ID 都是 v7」这条约定有区别。**响应里不回 token、不回 token_hash**（U21）。
- **不存 updated_at**：last_seen_at 就是它。
- **不存「设备名」**：前端从 user_agent 现解析，后端不留第三份。
- idx_sessions_expires 是**普通索引**不是部分索引：FK 索引检查（§14.3）会把部分索引判为「不可用」（数据库文档 §12.1 ②）。
- **唯一使用它的查询**是每小时一次的清理任务（`auth.PruneSessions`）：删「过期 ≥7 天」的会话行，`DELETE ... WHERE expires_at < $1 LIMIT 5000` 循环到删空。删行不影响任何正确性（会话本来就已经解析不出来了），清它是为了不让表无限增长。**没有它那个任务就是全表扫**——这是 §5.11 里"它服务哪条查询"的答案。email_tokens 同理（`PruneEmailTokens`：删「过期 ≥7 天」的令牌行）。

### 5.3 email_tokens

```sql
CREATE TABLE email_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea       NOT NULL CONSTRAINT ck_email_tokens_hash_len CHECK (octet_length(token_hash) = 32),
  purpose     text        NOT NULL CONSTRAINT ck_email_tokens_purpose CHECK (purpose IN ('verify','reset')),
  expires_at  ts          NOT NULL,
  consumed_at ts          NULL,
  attempt_count   smallint NOT NULL DEFAULT 0 CONSTRAINT ck_email_tokens_attempts CHECK (attempt_count >= 0),
  last_attempt_at ts       NULL,
  created_at  ts          NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_email_tokens_token ON email_tokens (token_hash);
CREATE INDEX        idx_email_tokens_user ON email_tokens (user_id);
-- 一个用户同一 purpose 只允许一条未消费的记录：让「重发」变成一次 upsert（§10.2）
CREATE UNIQUE INDEX uq_email_tokens_live  ON email_tokens (user_id, purpose) WHERE consumed_at IS NULL;
```

**这一节的形态由拍板 §11（2026-10-12 定案：邮箱激活从「点链接」改成「输 6 位验证码」）决定**，四处与最初设计不同：

1. **`token_hash` 里存的是 6 位数字码的 sha256**（拍板 §11.3：库里不存明文，与 session token 同一套做法）。列名与长度 CHECK 都不变（32 字节摘要）。
2. **`used_at` 改名 `consumed_at`**，与拍板 §11/§9.10 的用词一致；它同时是「一次性」与「试错 5 次后作废」的落点。
3. **新增 `attempt_count` 与 `last_attempt_at`**（拍板 §11.3 明确要求的两列）：前者数单个码的失败次数（第 5 次失败即作废），后者是下一次失败的时间（限流与排障用）。
4. **有效期缩短到 10 分钟**（拍板 §11.4）：两个 purpose 都是 10 分钟——`verify` 是验证码本身的有效期，`reset` 与它同张码、同一套试错上限，两条流程保持一致（拍板 §11.7 明确找回密码也是「输入验证码」）。**expires_at 仍然不给默认值**，由应用写死并写进测试。

### 5.4 roles

```sql
CREATE TABLE roles (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key          varchar(32)  NOT NULL UNIQUE,
  name         varchar(32)  NOT NULL,
  description  varchar(200) NOT NULL DEFAULT '',
  parent_id    bigint       NULL REFERENCES roles(id) ON DELETE RESTRICT,
  depth        int          NOT NULL DEFAULT 0,
  badge_color  varchar(16)  NULL,
  is_system    boolean      NOT NULL DEFAULT false,
  is_super     boolean      NOT NULL DEFAULT false,
  priority     int          NOT NULL DEFAULT 0,
  created_at   ts           NOT NULL DEFAULT now(),
  updated_at   ts           NOT NULL DEFAULT now(),
  CONSTRAINT ck_roles_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT ck_roles_depth_nonneg   CHECK (depth >= 0)
);

CREATE INDEX idx_roles_parent ON roles (parent_id);
CREATE UNIQUE INDEX uq_roles_super ON roles (is_super) WHERE is_super;
```

- priority **只用于后台展示排序，禁止用于授权判断**（数据库文档 §4.1）。
- uq_roles_super：全库最多一个 is_super 角色，这是「超管短路」的结构性保证。
- **is_super 是本设计新增的一列**（拍板 §1.3 只用文字描述「不可被降权」）。理由：没有它，authz.Require 的超管短路只能比较 `role.key == "superadmin"`，而方案 §15.23 明令禁止比较角色字符串。代价是多一列 + 一条自检，见 §17 U3。
- depth 的语义是**写入时算并存**（拍板 U18，2026-10-13 定案）：新建角色时按父角色的 depth+1 写入，改父节点时由 service 递归重算子孙。角色表 ≤ 几十行、改动极少，维护成本为零；读时递归算反而每处调用都要算一次。
- depth 不加「≤3」这类上界 CHECK：移动父节点时中间态会违反它；值域由 service 保证。
- **四个内置角色的 parent_id 都是 NULL**（各自独立，不是链）。理由与写穿规则见 §8.4——层级是给自定义角色用的，内置四个角色的权限矩阵本来就是完整列出的。

### 5.5 permissions

```sql
CREATE TABLE permissions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         varchar(64)  NOT NULL UNIQUE,
  grp         varchar(32)  NOT NULL,
  name        varchar(32)  NOT NULL,
  description varchar(200) NOT NULL DEFAULT '',
  created_at  ts           NOT NULL DEFAULT now()
);
```

key 的集合**必须等于** internal/authz/permissions.go 的常量集合（§14.1 启动自检）。grp ∈ {topic, board, user, title, site}；name 是后台勾选界面的中文名。迁移数据见 §8.6。

### 5.6 role_permissions

```sql
CREATE TABLE role_permissions (
  role_id       bigint NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
  permission_id bigint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at    ts     NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);
```

主键 (role_id, …) 已覆盖 role_id 侧的级联；permission_id 侧必须补单列索引，否则 §14.3 自检会红。

### 5.7 user_permissions

```sql
CREATE TABLE user_permissions (
  user_id       bigint       NOT NULL,
  permission_id bigint       NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by    bigint       NULL     REFERENCES users(id)       ON DELETE SET NULL,
  granted_at    ts           NOT NULL DEFAULT now(),
  expires_at    ts           NULL,
  reason        varchar(200) NOT NULL,
  PRIMARY KEY (user_id, permission_id),
  CONSTRAINT ck_user_permissions_expires CHECK (expires_at IS NULL OR expires_at > granted_at),
  CONSTRAINT ck_user_permissions_reason  CHECK (btrim(reason) <> '')
);

-- user_id 侧没有 REFERENCES 是有意的：
--   users 永不硬删（数据库文档 §2.11），而 ON DELETE CASCADE 会让「删用户」把提权记录一并抹掉——
--   提权记录是审计材料，不能因为删用户而消失。users 硬删只发生在测试夹具里，那里由夹具自己清。
--   （自检 §14.3 会把这条「无 FK」当正常：它按 pg_constraint 扫，没有 FK 就没有索引要求。）
CREATE INDEX idx_user_permissions_granted_by ON user_permissions (granted_by);    -- FK：SET NULL
CREATE INDEX idx_user_permissions_permission ON user_permissions (permission_id);  -- FK：删权限点
```

**刻意不建 `(user_id)` 单列索引**：`user_permissions` 是**唯一一张不给 users 建外键的表**（理由见上），所以不存在"删用户要扫子表"这条路径；而唯一按 user_id 查的语句是权限查询，它用的谓词是 `user_id = $2`（等值），清理任务也在旁路扫 `expires_at`——没有任何查询拿 `user_id` 做范围扫。所以 `(user_id)` 索引**服务不了任何查询**，按拍板 §5.9 第 7 条删掉。这就是"少一条 FK 换来少一条索引"的完整账。

**刻意不建 `(expires_at) WHERE expires_at IS NOT NULL`**（数据库文档 §4.1 的 `idx_user_permissions_expires`）：清理任务要扫的是「**已经**过期」的行，那是一个会随时间增长的集合，而部分索引的谓词只能是 IMMUTABLE 的（拍板 §5.9 第 1 条：`WHERE expires_at < now()` 建不出来）。改写成每天一次的全表范围扫 `DELETE ... WHERE expires_at < $1 - 7d LIMIT 5000`（循环到删空），表只有几百行，走顺扫比维护一个索引更划算。

**过期行清理不是正确性要求**（权限查询本来就过滤 expires_at），只是防表变胖：cron 每天删一次「已过期 ≥7 天」的行并写 audit_logs（action=`permission.expire`）。本域只提供 `PruneExpiredGrants(ctx, before time.Time) (int, error)`，注册进 cron 是 D1 的事。

### 5.8 audit_logs

```sql
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  action      varchar(64)  NOT NULL,
  target_type varchar(32)  NOT NULL,
  target_id   varchar(64)  NOT NULL,
  detail      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  ip          inet         NULL,
  created_at  ts           NOT NULL DEFAULT now(),
  CONSTRAINT ck_audit_logs_target_nonempty CHECK (btrim(target_id) <> '')
);

CREATE INDEX idx_audit_logs_actor  ON audit_logs (actor_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_logs_target ON audit_logs (target_type, target_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_logs_dump   ON audit_logs (created_at DESC, id DESC);
```

- 三条索引对应三个真实查询：actor= 筛选、target_type=&target_id= 筛选、全量导出（时间范围 + 游标）。
  **刻意不加 idx_audit_logs_action**：`action=` 是低频高选择性筛选，位图索引或顺扫都可接受；为它加第四条索引不值。
- target_id 存 public_id 字符串（用户 / 角色 key / 权限 key 等），**不存自增 id**（数据库文档 §2.3）。
- detail 只有两个形状：`{"before": …}`、`{"before": …, "after": …}`。不写「操作描述」，那是 action 的活。
- 不做分区、不做归档：量级是「管理员动作」，一年几千行。

### 5.9 本域不拥有、但会碰到的两张表

| 表 | 拥有者 | 本域用到什么 |
|---|---|---|
| board_moderators | D3 | (board_id, user_id, granted_by, granted_at, expires_at)；本域的 Resolve 要 JOIN 它算 Actor.BoardIDs（§6.4）。**D3 写这张表时必须调 auth.InvalidateUser(ctx, userID)** |
| default_avatars | D4 | users.avatar_hash IS NULL 时的回落是**读路径**的事：本域 DTO 照实返回 avatar 为空，由 media 的 URL 生成器决定填哪张默认图。本域**不存** default_avatar_hash（旧站「分一次就固定」与「按 id 取模」的选择见 §17 U20） |

外键索引提醒（对 D3/D4 的表同样适用）：board_moderators.user_id 必须有单列索引，数据库文档 §12.1 的自检会红（复合主键的第二列不算已索引）。

### 5.10 每条索引服务哪条查询（拍板 §5.9 第 7 条：答不出来就删）

| 索引 | 服务的查询 | 为什么不是重复/多余 |
|---|---|---|
| uq_users_username_lower | 登录、GET /users/{handle}、handle 占用检查 | 唯一性 + 大小写不敏感，三者都要 |
| uq_users_email_lower | 登录（username 字段可填邮箱）、找回密码 | 同上 |
| idx_users_created_at (created_at DESC, id DESC) | 后台用户列表游标 | 列序与游标同序（§5.9 第 4 条） |
| idx_users_role | FK（RESTRICT/改角色要扫） | 纯 FK 索引 |
| idx_users_avatar / _avatar_small / _equipped_title | FK（SET NULL） | 纯 FK 索引；§14.3 自检没有排除名单 |
| uq_sessions_token | Resolve 与批量 touch 的 WHERE 条件 | 唯一性 + 唯一热路径 |
| idx_sessions_user | FK（删用户级联） | 纯 FK 索引 |
| idx_sessions_expires | 「删过期会话」保留任务的范围扫 | 见 §15.3：不建它那个任务就是全表扫 |
| uq_email_tokens_token | 验证/重置令牌兑换 | — |
| uq_email_tokens_live (user_id, purpose) WHERE consumed_at IS NULL | 「重发」的 ON CONFLICT 目标 + 「一个 purpose 一条活跃记录」 | 唯一性约束本身，不只是查询 |
| idx_email_tokens_user | FK | 纯 FK 索引 |
| uq_roles_super WHERE is_super | 「全库最多一个超管角色」 | 唯一性约束，服务 §8.4 的短路 |
| idx_roles_parent | FK | 纯 FK 索引 |
| idx_role_permissions_permission | FK（删权限点）+ §14.3 自检 | 主键的第二列不算已索引 |
| idx_user_permissions_permission | FK（删权限点） | 主键的第二列不算已索引 |
| （**没有** `(user_id)` 索引） | — | user_permissions 无 users 外键，且没有按 user_id 的范围扫 |
| idx_user_permissions_granted_by | FK（SET NULL） | — |
| idx_audit_logs_actor / _target / _dump | 审计筛选（actor= / target=）与导出游标 | 三条列序都与游标同序 |

### 5.11 ent schema 与迁移的边界

| 只能写在手写迁移里 | 出现在 |
|---|---|
| 表达式唯一索引 uq_users_username_lower / uq_users_email_lower | 账号迁移 |
| 部分唯一索引 uq_roles_super / uq_email_tokens_live | 授权迁移、账号迁移 |
| 部分索引 idx_user_permissions_live | 授权迁移 |
| 全部 CHECK 约束（ck_users_* / ck_sessions_* / ck_email_tokens_* / ck_roles_* / ck_user_permissions_* / ck_audit_logs_*） | 各表迁移 |
| 全部外键的单列索引（ent 的 Index 只声明列，不建 FK 索引） | 各表迁移 |
| 四个角色 + 25 个权限点 + 勾选矩阵的 seed INSERT | `00xx_seed_rbac.sql` |
| images / titles 表必须先于 users 建立（FK 依赖） | 迁移顺序 |

迁移文件顺序（本域）：

    0001_extensions.sql          CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- 已有则复用
    0004_roles_permissions.sql   roles / permissions
    0005_users.sql               users（依赖 roles / images / titles）
    0006_account.sql             sessions / email_tokens
    0007_authorization.sql       role_permissions / user_permissions / audit_logs
    0008_seed_rbac.sql           4 角色 + 24 权限点 + role_permissions 矩阵（幂等 INSERT）

**forum create-admin 不做数据迁移**：它是一次 CLI 动作，写在启动脚本的部署步骤里（§8.7）。

---

## 6. 会话：凭据、Resolve、缓存、失效

### 6.1 token 的形状

    原始 token = 32 字节 crypto/rand → base64url（无填充，43 字符）→ Cookie 值
    库里存的    = sha256(原始 token) 的 32 字节原文 → bytea
    Cookie      = name=server.cookie_name, HttpOnly, Secure(https 时), SameSite=Lax,
                  Path=/, Max-Age=session_ttl(30 天)

- token 与它的摘要都不进日志（方案 §15.16）。
- csrf_token = 16 字节 crypto/rand → hex（32 字符），随 Principal 下发（方案 §9.3：默认同域部署时前端用不到它，但会话里必须有一份稳定的值）。
- **登出 / 踢设备都用 DELETE 删行**，不做 revoke 标记：行删了，缓存条目失效，cookie 立刻变成坏 token。

### 6.2 Resolve 的唯一一条 SQL（走 uq_sessions_token + users 主键）

```sql
-- internal/auth/pgsql/queries.go :: const resolveSessionSQL
SELECT s.token_hash,
       s.csrf_token,
       s.expires_at,
       s.id          AS session_id,
       u.id          AS user_id,
       u.public_id,
       u.nickname,
       u.status,
       u.email_verified_at,
       u.activated_at,
       u.avatar_hash,
       u.avatar_small_hash,
       r.id          AS role_id,
       r.key         AS role_key,
       r.name        AS role_name,
       r.badge_color AS role_badge_color,
       r.is_super,
       COALESCE(bm.board_ids, '{}'::bigint[]) AS board_ids
  FROM sessions s
  JOIN users u        ON u.id = s.user_id
  JOIN roles r        ON r.id = u.role_id
  LEFT JOIN LATERAL (
        SELECT array_agg(m.board_id ORDER BY m.board_id) AS board_ids
          FROM board_moderators m
         WHERE m.user_id = u.id
           AND (m.expires_at IS NULL OR m.expires_at > $2)
       ) bm ON true
 WHERE s.token_hash = $1
   AND s.expires_at > $2;
```

**EXPLAIN 预期**（§16 第 1 条要求）：`Index Scan using uq_sessions_token on sessions`（rows=1，token_hash 唯一）→ `Index Scan using users_pkey`（rows=1）→ `Index Scan using roles_pkey`（rows=1）→ `Index Scan using idx_board_moderators_user`（rows=0..3）。**没有任何 Seq Scan**，代价与表大小无关；表长到百万行也还是这四条 Index Scan。

**参数 `$2` 是 `s.clock.Now()`**，不是 PG 的 `now()`：会话过期是业务时间，必须能被 clock.Fake 控制（方案 §14.7）。board_moderators.expires_at 同理。

**过期 / 不存在的会话 = 游客**（方案 §9.2 决策 1）：`ErrSessionInvalid` → 清 Cookie → 当游客放行。库真挂了的错误才是 500。

### 6.3 缓存：一个条目装齐所有东西

    键   authn:sess:<hex(sha256(token))>          # 复用查库用的摘要，不再算一次哈希
    值   JSON { v:<epoch>, uid, pub, nick, sid, csrf, role_id, role_key, role_name, role_badge,
                is_super, perms[], boards[], extra[], status, verified, activated, avatar, avatar_small }
    TTL  auth.cache_ttl = 60s

    epoch 键 authn:epoch（永久，只有失效时 INCR）

**为什么条目必须同时带 status 与 BoardIDs**（方案 §9.2 决策 2 + 盲审 B1）：这是一个整体。status 放到别处（每次查库）而 perms 放缓存，就又是两份真源、两个 TTL；BoardIDs 不缓存，§6.2 的 LATERAL 子查询就每次都要跑。**一个条目、一次读、一起失效。**

**失效只有两条路，没有第三条**：

    InvalidateUser(ctx, userID)     → authn:epoch +1；并按已知摘要 Del 该用户的会话条目（有则删）
    InvalidateSession(ctx, digest)  → Del authn:sess:<digest>

- 读路径：命中条目后**先比 `v == epoch`**，不等就当未命中（回库）。所以 **epoch 失效不依赖 Del 成功**：Del 失败最多让旧条目在 TTL 内多活一次请求。**这就避开了「缓存写失败 → 权限不生效」这个安全级故障。**
- epoch 让每请求多一次 GET，这是代价（§16 第 2 条）。换来的是一条无法失败的安全失效路径。
- 条目数上限由 D1 的 kv.Cache 负责（方案 §9.8：例如 1 万条 LRU）。auth 不做第二套 LRU。

| 什么时候必须调 InvalidateUser | 调用点 |
|---|---|
| 封号 / 解封 | auth.BanUser（自己） |
| 改角色 / 追加 / 回收权限 | auth.SetUserRole / GrantPermission / RevokePermission（自己） |
| 改角色权限矩阵 | auth.ReplaceRolePermissions（自己） |
| 任免版主 | **D3 的版主写操作**（跨模块，一行契约） |
| 改昵称 / 简介 / 头像 | **不需要**（perms、status、boards 都没变；昵称变了就等 60 秒，可接受） |

**改密码 / 强制下线**走 `InvalidateSession` 逐个删（本来就在删 session 行，顺手删缓存），不用 epoch。
**不做「按用户列会话」的第二索引**：删行时我们手里要么是当前会话的摘要，要么是刚从库里 SELECT 出来的整批 token_hash。

### 6.4 LoadPrincipal 中间件（代码级说明）

```go
func (s *Service) LoadPrincipal() gin.HandlerFunc {
    return func(c *gin.Context) {
        raw, err := c.Cookie(s.cookieName())
        if err != nil || raw == "" {
            c.Next()                                   // 游客不是错误
            return
        }
        sum := sha256.Sum256([]byte(raw))
        p, err := s.resolveCached(c.Request.Context(), sum)
        switch {
        case errors.Is(err, ErrSessionInvalid):
            s.ClearCookie(c)                           // 过期/伪造：清掉，当游客
            c.Next()
        case err != nil:
            httpx.Fail(c, err)                         // 真故障（库挂了）才中断
            c.Abort()
        default:
            c.Set(ctxKey{}, p)
            s.TouchAsync(p.Digest)                     // 见 §6.5
            c.Next()
        }
    }
}
```

- **中间件只做认证**：不判权限、不读 body、不写响应体（除了清失效 Cookie）。没登录**不报错**。
- 中间件顺序：`requestid → access log → recover → LoadPrincipal → 限流 → RequireLogin → RequireActivated → Perm → handler`。
  `/static`、`/healthz`、`/readyz`、`/img/**` **不挂 LoadPrincipal**（白查一次库）。
- **401 / 403 分界**：没有 Principal → 401 `common.unauthorized`；有 Principal 但缺权限 → 403 `common.forbidden`。
  只在一处实现（`requirePerm(c, perms, any bool)`），`RequireLogin` / `Perm` / `PermAny` 都调它（方案 §9.2 决策 5）。

### 6.5 TouchAsync：节流 + 一条真实批量 UPDATE

    TouchAsync(digest)：
      1. 进程内 map[digest]lastTouch（带 1 万条上限，超了整表清空重建——它只是节流表，清掉只多写几次库）
      2. now - last < auth.touch_interval(10m) → 返回（请求路径上零写库）
      3. 记 last，非阻塞投 touchCh（缓冲 1024）；满了就丢——丢掉的只是「在线时间不准」

    后台一个 goroutine：500ms 或攒够 100 条 → 一个事务里跑下面两条 SQL

```sql
-- 1) 刷新活跃时间（每条会话一行，一次批量）
WITH t(digest, seen) AS (
  SELECT u.digest, u.seen
    FROM unnest($1::bytea[], $2::timestamptz[]) AS u(digest, seen)
)
UPDATE sessions s
   SET last_seen_at = GREATEST(s.last_seen_at, t.seen)
  FROM t
 WHERE s.token_hash = t.digest
   AND s.last_seen_at < t.seen;

-- 2) 滑动续期：每 renew_interval(24h) 才真的改一次 expires_at，别把它变成新的写热点
WITH t(digest, seen) AS (
  SELECT u.digest, u.seen
    FROM unnest($1::bytea[], $2::timestamptz[]) AS u(digest, seen)
)
UPDATE sessions s
   SET expires_at = t.seen + $3::interval                -- '720 hours'
  FROM t
 WHERE s.token_hash = t.digest
   AND s.expires_at < t.seen + ($3::interval - $4::interval);   -- $4 = '24 hours'
```

**走哪个索引**：`s.token_hash = t.digest` → `Index Scan using uq_sessions_token`，每条会话一次索引查找，代价与 sessions 表大小无关（嵌套循环）。
**为什么用 unnest 不拼 `VALUES (...),(...)`**：不拼 SQL 字符串（方案 §15.8），数组参数天然是一次往返。
**为什么不按 session id 批量**：TouchAsync 手上只有摘要，为省一次映射而把摘要换成自增 id 在 channel 里传，是多一层耦合。

**「1000 次请求 ≤ 1 次 UPDATE」怎么测**（方案 §9.2 必须写的测试）：不数 SQL 条数，数**被改动的会话行数**。把批量刷写做成注入的 `func(ctx, pairs []touchPair) error`，测试用假函数累计行数：clock.Fake 固定时间 + 1000 次请求 → 断言累计 1 行；再断言 `expires_at` 一次都没被改（24 小时未到）；把 clock 前进 11 分钟再来 1 次 → 累计 2 行。

### 6.6 失效路径（每一条都要有测试）

| 动作 | 做什么 | 该用户旧 Cookie 的后果 |
|---|---|---|
| 管理员封号 `status='banned'` | 一个事务：UPDATE users + 写审计；提交后 InvalidateUser | 下一请求：缓存条目里 status=banned → `ErrSessionInvalid` → 清 Cookie 当游客；写接口 401（**不等 60 秒**） |
| 改密码 | 一个事务：UPDATE password_hash + `DELETE FROM sessions WHERE user_id=$1` + 删 purpose='reset' 的令牌 + 写审计 | 行没了 → `Resolve` 无行 → 游客 → 401 |
| 强制下线 / 踢某台设备 | `DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING token_hash` + InvalidateSession | 同上 |
| 任免版主 | D3 写 board_moderators + 调 `auth.InvalidateUser` | 下一请求 epoch 不匹配 → 回库 → BoardIDs 更新（≤1 个请求） |
| 改角色 / 追加 / 回收权限 | 写表 + `InvalidateUser` | 同上（≤1 个请求，不是 60 秒） |

**封号不删会话行**：删行会让解封后用户「莫名其妙要重新登录」，而且不可逆。users.status 是唯一真源，会话行只是凭据。

---

## 7. 注册与登录

### 7.1 注册 `POST /api/v1/auth/register`

入参：`{ username, email, password, captcha? }`。

**校验（信任边界，全部在这里做）**：

| 字段 | 规则 | 失败 |
|---|---|---|
| username | ASCII 3..24 字节，`^[A-Za-z0-9_][A-Za-z0-9_-]{2,23}$`（首字符不能是 `-`，旧站语义） | 400 common.invalid_input + fields |
| email | ≤254 字节，`net/mail.ParseAddress` 可解析且带域名，落库前去空白 + 小写 | 400 |
| password | 8..128 **字节**且不能全空白（旧站语义） | 400 |
| nickname | 不填 → 回落成 username | 400（有填但非法时） |
| captcha | mode=off 不要求；on_failure 时同 IP 10 分钟内失败 ≥5 次才要求；always 必填 | 400 auth.captcha_required / auth.captcha_wrong |

**流程（顺序有理由）**：

    1. 限流**两道，失败与成功分开算**（2026-10-16 用户定口径）：尝试池 `auth:register:attempt:ip:<ip>` **60 次/小时**（进端点第一件事、排在校验之前，手误与 5xx 重试都吃它，也挡住无成本刷 argon2/发信）；成功池 `auth:register:success:ip:<ip>` **3 次/小时**（校验都过、handle 与邮箱都没被占时计数，挡的是「一个 IP 批量造号」）。原先是「3 次/小时」一把梭 —— 固定窗口下 3 次重试就锁一小时（用户报 request_id 42c1eee284e6504a：那 3 次还是被昵称校验的 500 烧掉的）
    2. 校验 + 归一化
    3. **事务外**算 argon2id 哈希        ← 32MB + 几十毫秒，绝不放事务里
    4. 取信号量（§7.4）：等不到 3 秒 → 503
    5. WithTx：
         INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
           VALUES ($1,$2,$3,$4,$5,(SELECT id FROM roles WHERE key='user')) RETURNING id;
         -- 唯一索引冲突 → ent.IsConstraintError → 409 common.conflict（按约束名区分是 username 还是 email）
         INSERT INTO email_tokens (...) ON CONFLICT ...（§10.2）
         INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
           VALUES (NULL, 'user.register', 'user', $public_id, '{}'::jsonb, $ip);
    6. 提交后 Queue.Enqueue（mail:send, purpose=verify）   ← 事务里禁止发邮件/入队（方案 §14.6）

**响应 201 + `{"data":{"id":public_id,"handle":username,"email_verified":false}}`，不建会话、不自动登录。**
理由：邮箱未必是真的，先给会话等于一个假邮箱换一个可写会话；多一次登录对正常用户是零成本。因此注册后 `GET /api/v1/me` 返回 `data: null` 是**对的**，不是 bug。

### 7.2 登录 `POST /api/v1/auth/login`

入参：`{ username, password, captcha? }`。`username` 字段**同时接受登录名与邮箱**（不新增端点）。

    1. 限流两道：auth:login:ip:<ip> 10/分钟、auth:login:user:<lower(login)> 5/分钟 → 429 + Retry-After
    2. 查账号行（下面那条 SQL）
    3. **恒时校验**：账号不存在也走一次 argon2 校验（进程内固定的 dummy PHC 串），
       让「存在」与「不存在」的响应时间接近；一律 401 auth.bad_credentials（不区分哪个错）
    4. status = 'banned' → 401 auth.bad_credentials（对外不暴露被封；与「旧 Cookie 立刻变游客」一致）
    5. **邮箱未验证：允许登录**（§9）。这一条要写死，别在实现时按方案 §9.1 的旧句子又加一道拒绝
    6. rehash 判定（§7.3）
    7. WithTx：INSERT sessions(... expires_at = $now + 720h) RETURNING id
              + INSERT audit_logs('user.login', ...)
              + UPDATE users SET last_login_at = $now
              + （若需 rehash）UPDATE users SET password_hash = $new, updated_at = $now
    8. 提交后 Set-Cookie；不需要 InvalidateUser（perms 没变）

**不设会话数上限**：用户量小、一会话一行、TTL 30 天；要防的是同一账号被爆破，那由第 1 步管。

#### 查账号行（唯一一处按 username 或 email 查）

```sql
-- internal/auth/pgsql/queries.go :: const findUserByLoginSQL
SELECT u.id, u.public_id, u.username, u.email, u.password_hash, u.nickname,
       u.status, u.email_verified_at, u.activated_at, u.trusted,
       u.avatar_hash, u.avatar_small_hash, u.exp, u.level,
       u.role_id, r.key AS role_key, r.is_super
  FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE lower(u.username) = lower($1)
    OR lower(u.email)    = lower($1)
 LIMIT 2;
```

**EXPLAIN 预期**：`BitmapOr` over `Index Scan using uq_users_username_lower` + `Index Scan using uq_users_email_lower`（或两条 Index Scan 的 Append）。
**关键：`lower(col) = lower($1)` 与索引表达式逐字一致**——写成 `u.username = $1` 或 `lower(u.username) = $1` 都会退化成 Seq Scan。这条要写进代码评审清单（数据库文档 §2.9）。
`LIMIT 2`：查出两行说明「同一个字符串既是某人的 username 又是另一人的 email」——按 `ORDER BY u.id` 取第一行；注册时禁止 username 与既有 email 相同、反之亦然（取舍见 §17 U17）。

### 7.3 argon2id：参数、PHC 串、rehash

    参数    time=2, memory=32*1024 KiB, threads=2, keyLen=32, salt=16 字节 crypto/rand
    PHC 串  $argon2id$v=19$m=32768,t=2,p=2$<base64(salt)>$<base64(hash)>
    校验    argon2.IDKey(...) → subtle.ConstantTimeCompare

```go
// internal/auth/password.go
type argon2Params struct{ Time uint32; Memory uint32; Threads uint8; KeyLen uint32 }

var newParams = argon2Params{Time: 2, Memory: 32 * 1024, Threads: 2, KeyLen: 32}

// needsRehash：PHC 串弱于当前参数即为 true。解析失败（旧站占位值 "!"）返回 false——
// 那种账号根本走不到这里，校验已经失败了。
func needsRehash(phc string) bool { … }
```

**rehash 的判定与写回位置（照这个写）**：

    判定：verifyPassword 成功之后、建会话之前，调 needsRehash(row.password_hash)
    判据：memory < 32768 || time < 2 || threads != 2 || len(salt) < 16 || len(key) != 32
    写回：与 INSERT sessions **同一个事务**：UPDATE users SET password_hash=$2, updated_at=$now WHERE id=$1
    失败：整个事务回滚 → 登录返回 500。**不返回「登录成功但哈希没升级」**——那会让下次登录继续用弱参数，
          而用户看到的是成功，问题永远不会被发现
    不做：不在后台任务里补算（服务端没有明文密码，只有登录那一刻才有）

**旧站哈希**：`$argon2id$v=19$m=19456,t=2,p=1$…`（19MiB/t=2/p=1，旧站用户表提取 §3），PHC 自描述可直接校验；19MiB < 32MiB → 登录成功即重算。
**必须有的测试**：拿一条 m=19456 的真实旧串 + 明文，断言登录成功后库里的串变成 m=32768，且用同一明文仍能校验通过。
**占位值 `"!"`**：`parsePHC` 失败 → 校验恒失败 → 该账号不能用密码登录（旧站引导账号语义）。**不要**为它加「无密码登录」分支。

### 7.4 并发哈希信号量（方案 §9.1 硬要求）

```go
type hasher struct {
    sem  chan struct{}   // make(chan struct{}, cfg.Argon2MaxConcur) 默认 2
    wait time.Duration   // cfg.Argon2WaitTimeout 默认 3s
    log  *slog.Logger
}

func (h *hasher) acquire(ctx context.Context) error {
    t := time.NewTimer(h.wait); defer t.Stop()
    select {
    case h.sem <- struct{}{}:
        return nil
    case <-t.C:
        h.log.Warn("argon2 信号量等待超时", "in_flight", len(h.sem), "wait", h.wait)
        return ErrHashBusy
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

- **两处调用都必须过信号量**：登录校验、注册/改密码/重置的哈希。**哈希算完才 release**（defer）。
- 拿不到 → `ErrHashBusy = apperr.New(503, "auth.hash_busy", "服务器繁忙，请稍后再试")`。
  为什么 503 不是 429：429 是「你太快了」，503 是「我这会儿处理不了」；重试语义一样，但对运维是好信号（方案 §9.1 写的就是 503）。
- **测试**：用可阻塞的假 hasher 顶满信号量，第 3 个请求断言 ~3 秒内返回 503；释放后能正常通过。再加方案 §17 M2 的并发验收：并发 10 个登录时堆峰值 < 100MB（不加信号量会到 320MB）。

### 7.5 登出 `POST /api/v1/auth/logout`

```sql
DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash;
```

再 `InvalidateSession(hex(token_hash))` + `ClearCookie`。**幂等**：没删到行也返回 200。

---

## 8. 授权：RBAC

### 8.1 三个概念（不要混）

    role            基线角色（roles 一行）——一个人只有一个
    permission      权限点（permissions 一行）——代码常量定义、迁移写入，后台不能新增
    user_permission 点对点追加——给某个人加某几个权限点，带原因与期限

### 8.2 有效权限集合的定义（写死）

    有效权限(user) = 基线角色权限集(user.role_id)
                   ∪ { p ∈ user_permissions(user) : p.expires_at IS NULL OR p.expires_at > now }

    基线角色权限集(role) = role_permissions(role) ∪ ⋃ { role_permissions(a) : a 是 role 的任一祖先 }

    roles.is_super = true → 判定一律短路「通过」，不参与上面的集合运算

**为什么把「祖先」也算进来**：RBAC 文档 §1.1/§6 要求「每个非根角色的权限集合 ⊇ 父角色（写穿没漏）」。两种实现：

| 方案 | 语义 | 代价 |
|---|---|---|
| A 写穿：改父角色时递归写到所有后代 | role_permissions 里就是展开后的并集，读路径一次 JOIN | 要挡住「子角色缺了父角色刚被取消的权限」；一次改动可能很大，写到一半失败会留中间态 |
| **B 读时闭包（本设计采用）** | 读路径多一层递归闭包 | 读多一次递归；但**改一次权限只写一行**，没有中间态 |

**采用 B**，且**四个内置角色的 parent_id 全为 NULL**（§5.4）——内置角色的权限集就精确等于 role_permissions 里那一行行勾选，§8.6 的矩阵就是真源，不多不少。层级只给以后的自定义角色用：父角色勾一下，子角色立刻有，不需要重跑迁移。
取舍与「我可能被推翻的地方」见 §17 U8。

### 8.3 权限查询（唯一一条 SQL，ent 表达不了）

```sql
-- internal/auth/pgsql/queries.go :: const loadActorSQL
-- 过期判定写在 WHERE 里（拍板 §5.9 第 1 条：谓词里不能有 now()，所以没有「未过期的追加权限」这个部分索引）
WITH RECURSIVE chain AS (
        SELECT r.id, r.parent_id, r.is_super FROM roles r WHERE r.id = $1
  UNION ALL
        SELECT p.id, p.parent_id, p.is_super
          FROM roles p JOIN chain c ON p.id = c.parent_id
),
perms AS (
        SELECT DISTINCT rp.permission_id
          FROM role_permissions rp
          JOIN chain c ON c.id = rp.role_id
  UNION
        SELECT up.permission_id
          FROM user_permissions up
         WHERE up.user_id = $2
           AND (up.expires_at IS NULL OR up.expires_at > $3)
)
SELECT u.id, u.public_id, u.status, u.email_verified_at, u.activated_at,
       u.avatar_hash, u.avatar_small_hash,
       r.id, r.key, r.name, r.badge_color, r.is_super,
       COALESCE((SELECT array_agg(p.key ORDER BY p.key)
                   FROM perms x JOIN permissions p ON p.id = x.permission_id), '{}'::text[]) AS perm_keys,
       COALESCE((SELECT array_agg(m.board_id ORDER BY m.board_id)
                   FROM board_moderators m
                  WHERE m.user_id = u.id AND (m.expires_at IS NULL OR m.expires_at > $3)), '{}'::bigint[]) AS board_ids,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('key', p.key, 'expires_at', up.expires_at) ORDER BY p.key)
                   FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
                  WHERE up.user_id = u.id AND (up.expires_at IS NULL OR up.expires_at > $3)), '[]'::jsonb) AS extra
  FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE u.id = $2;
```

**为什么是原生 SQL**：`WITH RECURSIVE` ent 表达不了；`array_agg` 一次取回整个权限集合，比「先查 id 再逐条查」少 N 个往返。
**EXPLAIN 预期**：`Index Scan using users_pkey`（rows=1）→ `Index Scan using roles_pkey` → `Index Scan using role_permissions_pkey`（rows≈24）→ `Index Scan using idx_user_permissions_user`（0..5）→ `Index Scan using idx_board_moderators_user`（0..3）→ `Index Scan using permissions_pkey`（≈24）。
**roles / permissions / role_permissions 是常数级表**（角色 ≤ 几十行、权限 24 行），所以这条查询的代价永远是「几十次索引查找」，与用户数、帖子数无关。**参数 `$3` 是 clock 的 now**（同 §6.2）。

### 8.4 authz 的代码级说明（三条必须写死的语义）

```go
// internal/authz/actor.go
type Actor struct {
    UserID        int64
    PublicID      string
    Perms         Set
    BoardIDs      []int64
    RoleID        int64
    RoleKey       string   // 只用于展示与审计，禁止用于判定
    RoleName      string
    RoleBadge     string
    IsSuper       bool
    EmailVerified bool
    Activated     bool
    Status        string   // active / banned / deleted
}

// Require 是 service 层兜底；队列 / cron / CLI 不走路由，只靠它。
func Require(a *Actor, perm string) error {
    if a == nil || a.Status != "active" { return ErrUnauthorized }  // 未登录 / 封号
    if a.IsSuper { return nil }                                     // ← 超管短路，必须第一优先
    if a.Perms.Has(perm) { return nil }
    return ErrForbidden
}

// CanInBoard 只回答「是不是这个分区的版主」；分区 ACL（can_post/deny_post）由 forum 查表后判（§8.5）。
func CanInBoard(a *Actor, boardID int64) bool {
    if a.IsSuper { return true }
    for _, id := range a.BoardIDs { if id == boardID { return true } }
    return false
}

func HasAny(a *Actor, perms ...string) bool { … }   // PermAny 中间件用
```

**① 超管短路**：`Require` 与 `Perm` 都在**权限集合之前**判 `IsSuper`。理由（方案 §9.8）：以后新增权限点时超管的基线角色里没有那个勾，超管会被自己拦住。`IsSuper` 来自 `roles.is_super`（§5.4），**不是比较 `role.key == "superadmin"`**。

**③ 作用域权限不进中间件**：`board.moderate` / 资源归属这类判定**不能放在路由中间件里**。理由是中间件的入参只有 `*gin.Context`：路由参数里只有 topic id、没有 board id，中间件要判"他是不是这个分区的版主"就得先查库——那等于把一次业务查询塞进中间件，而且它查到的 board_id 与 service 随后用到的可能不是同一份（并发下会错）。所以：

- 中间件只判**全局**权限点（`topic.delete.any`、`user.ban`、`role.assign` …）；
- `board.moderate` 的判定**只在 service 层**：先拿到 board_id（查 topic 或直接用路径参数），再 `authz.CanInBoard(actor, boardID)`；
- **资源归属同理**：`topic.delete.own` 只回答"这类动作允不允许"，"这条是不是我的"由 service 判 `topic.AuthorID == actor.UserID`；只有持 `topic.delete.any` 才跳过归属判定。**顺序是：先 `authz.Require`、再判归属，两者 AND。**
- 这条同时解释了 §8.5 那张表为什么把"分区版主"与"D6 发言 ACL"都划给 forum：它们的入参是 board_id，只有 service 层才有。


### 8.5 与 forum 的分工（写清楚，免得两边都判或都不判）

| 判定 | 谁做 | 用什么 |
|---|---|---|
| 全局权限点 | 路由中间件 `Perm(...)` + service 层 `authz.Require` 各一次 | `actor.Perms` |
| 分区版主 | **forum（D3）** service | `authz.CanInBoard(actor, boardID)` |
| 分区发言 ACL（D6） | **forum（D3）** service | 自己查 board_acls，按拍板 §1.5 的 6 步判定（第 1 步用 `actor.IsSuper`，第 4 步用**基线角色那一行**） |
| 资源归属 | 各业务 service | 实体上的 author_id |
| 三根状态轴 | auth（会话解析）+ authz.Require | `actor.Status / EmailVerified / Activated` |

**D3 写 `board_moderators` 后必须调 `auth.InvalidateUser(ctx, userID)`**，否则版主上任要等 60 秒（本域唯一强制的跨模块回调）。

### 8.6 RBAC 迁移数据（唯一真源在这里）

#### 权限点常量（`internal/authz/permissions.go`，25 个）

```go
const (
    PermTopicCreate      = "topic.create"      // 发主题/回复/issue/issue 评论
    PermTopicEditOwn     = "topic.edit.own"
    PermTopicDeleteOwn   = "topic.delete.own"
    PermTopicDeleteAny   = "topic.delete.any"
    PermTopicLock        = "topic.lock"
    PermTopicPin         = "topic.pin"
    PermTopicFeature     = "topic.feature"
    PermTopicMove        = "topic.move"
    PermResourcePublish  = "resource.publish" // 发 kind='resource' 的主题（service 层加判）
    PermBoardManage      = "board.manage"
    PermBoardModerate    = "board.moderate"    // 作用域：只在 board_moderators 命中的分区
    PermPostReview       = "post.review"
    PermReportHandle     = "report.handle"
    PermRewardVerify     = "reward.verify"
    PermTitleGrant       = "title.grant"
    PermTitleManage      = "title.manage"
    PermRoleEdit         = "role.edit"
    PermRoleAssign       = "role.assign"
    PermPermissionGrant  = "permission.grant"
    PermUserBan          = "user.ban"
    PermUserMute         = "user.mute"
    PermMailManage       = "mail.manage"
    PermSiteSetting      = "site.setting"
    PermAuditView        = "audit.view"
    PermAuditExport      = "audit.export"
)
```

**25 个，与拍板 §1.2 的关系（2026-10-13 复核）**：
- 拍板 §1.2 的表里数出 **24 行**（含 `topic.feature`；§9.12 也确认表头原来写的「23 个」是笔误，以 24 为准）；
- 拍板 §9.9 的 U1/U2 裁决要求**补上 `resource.publish`**（"发 `kind='resource'` 的主题要比普通发帖多这一条（service 层判，因为它依赖 body 里的 kind）"），而 §1.2 的表里实际没有它 → **24 + 1 = 25**；
- 所以本设计取 **25 个**。**Lead 回写时请把 §1.2 的表补上 `resource.publish` 这一行**——否则常量表与迁移数据会差一个点，§14.1 的启动自检会红。

**一条必须与 P1 对齐的待办**（拍板 §10.8 第 1 条已把它记为待拍板）：P1b 已落库的迁移里是 **24 个**权限点（`topic.pin` 兼管 `/feature`，且没有 `resource.publish`）。如果 P1b 已经执行过，那么两条路必须选一条并落到迁移里：

- **A（补）**：新增迁移插入 `resource.publish`，并决定 `topic.feature` 的归处——**保留它就必须把 `/feature` 端点改成判 `topic.feature`**，否则它就是一个永不生效的勾；
- **B（退）**：常量表回退到 24 个（删 `topic.feature` 与 `resource.publish`，精华回到 `topic.pin` 兼管）。

**在两处对齐之前不要跑 §14.1 的自检**——它会红，而那是它该有的行为。

#### permissions 迁移数据（`0008_seed_rbac.sql`）

```sql
INSERT INTO permissions (key, grp, name, description) VALUES
 ('topic.create','topic','发主题与回复','发主题、发回复、发 issue 与 issue 评论'),
 ('topic.edit.own','topic','编辑自己的内容','改自己的主题/回复/issue'),
 ('topic.delete.own','topic','删除自己的内容','删自己的主题/回复'),
 ('topic.delete.any','topic','删除任何人的内容','配合 service 的归属判定'),
 ('topic.lock','topic','锁定主题','锁定/解锁'),
 ('topic.pin','topic','置顶','置顶/取消'),
 ('topic.feature','topic','精华','精华/取消，独立权限点'),
 ('resource.publish','topic','发布资源帖','发 kind=resource 的主题；与 topic.create 同时判定'),
 ('topic.move','topic','移动主题','把主题移到别的分区'),
 ('board.manage','board','分区管理','分区增删改、排序、封面、BoardACL'),
 ('board.moderate','board','分区版主','作用域权限，只在被任命的分区内生效'),
 ('post.review','topic','帖子审核','审核队列：放行/拒绝/请求修改'),
 ('report.handle','user','处理举报','举报队列'),
 ('reward.verify','user','赞赏核验','人工核验打赏申报'),
 ('title.grant','title','授予头衔','给用户发/收头衔'),
 ('title.manage','title','头衔目录维护','新建/归档头衔'),
 ('role.edit','user','编辑角色权限','改角色×权限矩阵'),
 ('role.assign','user','分配角色','改 users.role_id（与 role.edit 必须分开）'),
 ('permission.grant','user','点对点授权','追加/回收某人的权限点'),
 ('user.ban','user','封号与解封','封号/解封'),
 ('user.mute','user','分区限期禁言','Sanction 表'),
 ('mail.manage','site','发信账号维护','后台邮件账号'),
 ('site.setting','site','站点设置','键值、公告、横幅、自检面板'),
 ('audit.view','site','查看审计日志','—'),
 ('audit.export','site','导出审计日志','单列：能一次导走全站操作痕迹')
ON CONFLICT (key) DO UPDATE SET grp = EXCLUDED.grp, name = EXCLUDED.name, description = EXCLUDED.description;
```

`name` 是后台勾选界面的中文标签，`description` 是勾选框旁边的一行灰字。**权限点只能由这条迁移写入**（方案与拍板都禁止后台新增权限点）。

#### 四个内置角色（同一条迁移）

```sql
INSERT INTO roles (key, name, description, parent_id, depth, badge_color, is_system, is_super, priority) VALUES
 ('user',       '普通用户',   '注册即得',                 NULL, 0, NULL,      true, false, 0),
 ('creator',    '认证创作者', '经认证的资源作者',         NULL, 1, '#2563eb', true, false, 1),
 ('admin',      '管理员',     '内容与用户管理',           NULL, 2, '#d97706', true, false, 2),
 ('superadmin', '超级管理员', '不可被降权，只能由 CLI 授予', NULL, 3, '#dc2626', true, true,  3)
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
      depth = EXCLUDED.depth, badge_color = EXCLUDED.badge_color, is_super = EXCLUDED.is_super,
      priority = EXCLUDED.priority;
```

**四个角色的 `parent_id` 都是 NULL（各自独立，不成链）**。理由（也是 U8 的取舍）：
- 内置角色的权限矩阵本来就是**完整列出**的（下表），父链只会让"勾选框状态"与"实际生效"产生第二个来源；
- 它同时**关掉了"写穿漏了"这个失败模式**（RBAC 文档 §6 第 2 条自检在四角色场景下无对象，自然通过）；
- 代价：前端的"角色树"对内置四角色显示为四个根节点。**可以接受**——它们本来就不是嵌套关系。

#### 勾选矩阵（`role_permissions`，写死）

| 权限点 | user | creator | admin | superadmin |
|---|:--:|:--:|:--:|:--:|
| topic.create | ✓ | ✓ | ✓ | ✓ |
| topic.edit.own | ✓ | ✓ | ✓ | ✓ |
| topic.delete.own | ✓ | ✓ | ✓ | ✓ |
| topic.lock | — | ✓ | ✓ | ✓ |
| topic.move | — | ✓ | ✓ | ✓ |
| topic.pin | — | ✓ | ✓ | ✓ |
| topic.feature | — | ✓ | ✓ | ✓ |
| resource.publish | — | ✓ | ✓ | ✓ |
| topic.delete.any | — | — | ✓ | ✓ |
| board.manage | — | — | ✓ | ✓ |
| board.moderate | — | — | ✓ | ✓ |
| post.review | — | — | ✓ | ✓ |
| report.handle | — | — | ✓ | ✓ |
| reward.verify | — | — | ✓ | ✓ |
| title.grant | — | — | ✓ | ✓ |
| title.manage | — | — | ✓ | ✓ |
| user.ban | — | — | ✓ | ✓ |
| user.mute | — | — | ✓ | ✓ |
| role.edit | — | — | — | ✓ |
| role.assign | — | — | — | ✓ |
| permission.grant | — | — | — | ✓ |
| mail.manage | — | — | — | ✓ |
| site.setting | — | — | — | ✓ |
| audit.view | — | — | — | ✓ |
| audit.export | — | — | — | ✓ |

合计：user 3 个、creator 8 个、admin 18 个、superadmin 25 个。

- `creator` 拿 `topic.move` 是拍板 §1.3「creator 能管自己的帖子」的落地：移动**自己的**帖子到别的分区是作者动作（归属判定在 forum）。**若产品认为移动分区只能由管理员做，把这一格去掉即可。**
- `resource.publish` 只给 creator 及以上（拍板 U2）：它**不替代** `topic.create`，而是发 `kind='resource'` 时**多要的一条**——forum 的判定顺序是「先 `topic.create`，若 kind=resource 再要 `resource.publish`」，两者 AND。
- `board.moderate` 给 admin 是**无害且必要**的：它只在 `board_moderators` 命中时生效，而"管理员被任命为某分区版主"是正常用法。

```sql
-- 普通用户 3 个
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN
  ('topic.create','topic.edit.own','topic.delete.own')
 WHERE r.key = 'user'
ON CONFLICT DO NOTHING;

-- 认证创作者 8 个
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN
  ('topic.create','topic.edit.own','topic.delete.own',
   'topic.lock','topic.move','topic.pin','topic.feature','resource.publish')
 WHERE r.key = 'creator'
ON CONFLICT DO NOTHING;

-- 管理员 18 个（user 3 + creator 5 + 管理类 10）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN
  ('topic.create','topic.edit.own','topic.delete.own',
   'topic.lock','topic.move','topic.pin','topic.feature','resource.publish',
   'topic.delete.any','board.manage','board.moderate','post.review',
   'report.handle','reward.verify','title.grant','title.manage','user.ban','user.mute')
 WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;

-- 超级管理员 25 个
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.key = 'superadmin'
ON CONFLICT DO NOTHING;
```

**迁移幂等且不覆盖后台调整**：`ON CONFLICT DO NOTHING`——重跑不会把管理员改过的勾选抹回原样。
（**注意**：如果 P1b 已经跑过 24 个的版本，这一段 `ON CONFLICT DO NOTHING` **不会**把新加的 `resource.publish` 补进已有的 creator/admin/superadmin 行——新增权限点的迁移必须显式写"给哪些角色补这一条"，见 RBAC 文档 §8。）新增权限点的流程见 RBAC 文档 §8（加常量 → 迁移插 `permissions` 行 + 给需要它的**内置**角色补行；新权限点不会自动授予自定义角色，这是 RBAC 固有行为）。

### 8.7 create-admin（`forum create-admin`）

    用法：forum create-admin --handle tangtian --email t@example.com --nickname 唐天 [--password-stdin]
    行为：1) 已存在同 lower(handle) 或 lower(email) → 报错退出（**不做隐式升级**）
          2) 事务内：INSERT users(... role_id = 该超管角色,
                     email_verified_at = now(), activated_at = now(), trusted = true)
                     + INSERT audit_logs('user.create_admin', actor=NULL)
          3) 密码从 stdin 读，走与注册同一个 argon2 哈希与信号量

- 它自己**不受"最后一个超管"守卫限制**（只增不减）。
- 与旧站导入的关系：`forum import-users` 把旧 4 级角色映射到四个内置角色之一（数据库文档 §10.2）；`uq_roles_super` 只限制"角色表里只有一个 is_super 角色"，**不限制用户数**。
- **S2 之后、上线之前必须跑一次**，否则没人能进后台。

### 8.8 三个提权操作的边界（`role.edit` / `role.assign` / `permission.grant`）

| 权限点 | 能做什么 | 不能做什么 | 端点 |
|---|---|---|---|
| `role.edit` | 改**角色**的权限矩阵（含新建/改名自定义角色） | 改任何用户的角色；给别人加点对点权限 | `GET /admin/roles`、`GET /admin/permissions`、`PATCH /admin/roles/{id}/permissions` |
| `role.assign` | 改**某个用户**的基线角色（`users.role_id`） | 改角色矩阵 | `PATCH /admin/users/{id}/role` |
| `permission.grant` | 给某个用户**追加/回收具体权限点** | 改角色矩阵；改基线角色 | `POST/DELETE /admin/users/{id}/permissions/{perm_key}` |

**为什么必须分成三个**：单持其一的任何人都**不可能**给自己提到全站最高权：
- 只有 `role.edit`：能改**自己所属角色**的矩阵 → **这确实能提权**。所以第二道锁是：本矩阵里只有 superadmin 有 `role.edit`。
- 只有 `role.assign`：能把某人（含自己）提到 admin，而 admin 拿不到 `role.edit`/`role.assign`/`permission.grant` —— **天花板是 admin**。
- 只有 `permission.grant`：能追加任意权限点，但本矩阵里只有 superadmin 有它。

**结论**：三条路的天花板都是 admin，而 admin 无法再往上。这是**结构性**保证（§8.6 的矩阵里 admin 那一行没有那三个勾），不是"靠人记得"。

#### `PATCH /admin/roles/{id}/permissions`（全量替换）

```sql
-- 一个事务：锁 role → 校验权限点存在 → 全量替换 → 审计
SELECT id, key, is_system FROM roles WHERE id = $1 FOR UPDATE;   -- 内置角色允许改矩阵

DELETE FROM role_permissions WHERE role_id = $1;

INSERT INTO role_permissions (role_id, permission_id)
SELECT $1, p.id FROM permissions p WHERE p.key = ANY($2::text[])
 ORDER BY p.id                        -- 固定加锁顺序，避免两个并发矩阵编辑死锁
ON CONFLICT DO NOTHING;
```

- **一次 INSERT ... SELECT**，不是 N 次插入（24 行一次往返）。
- **锁 role 行**：两个管理员同时保存同一角色的矩阵时串行化，后保存的赢（全量替换语义）。
- 审计：`action='role.permissions.edit'`，detail 的 before/after 都是**排序后的完整 key 数组**（差异由前端 diff，不在后端算）。
- **不允许删/改内置角色的 `key` 与 `is_system`**；**允许**改内置角色的权限矩阵（这正是"角色可以在后台配"的意思）。
- **失效范围**：epoch 是全局一个，一次 INCR 让**所有**缓存条目失效。代价是改一次角色会让全站重建缓存（几十~几百次查库），收益是**不需要按角色找用户**。

#### `PATCH /admin/users/{id}/role`

```sql
-- 事务内，按顺序
SELECT u.id, u.public_id, u.role_id, r.key AS role_key, r.is_super, u.status
  FROM users u JOIN roles r ON r.id = u.role_id
 WHERE u.id = $1
 FOR UPDATE OF u;                                     -- 锁目标行（并发降权串行化）

SELECT id FROM roles WHERE id = $2;                    -- 新角色必须存在（否则 admin.role_not_found）

-- 仅当「原本 is_super 且新角色不是 superadmin」时执行 §8.9 的 remaining 检查

UPDATE users SET role_id = $2, updated_at = $3 WHERE id = $1;

INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
VALUES ($4, 'user.role.assign', 'user', $5,
        jsonb_build_object('before', jsonb_build_object('role', $6),
                           'after',  jsonb_build_object('role', $7)), $8);
```

- `actor` 自己要有 `role.assign`（中间件已判，service 里 `authz.Require` 再判一次）。
- **目标 role 不做"等级比较"**：不存在"不能把别人提到比自己高"的规则——本矩阵下只有 superadmin 有 `role.assign`，而他已经是最高。
- 提交后：`InvalidateUser(ctx, targetID)`。

#### `POST /admin/users/{id}/permissions/{perm_key}`

```sql
-- 一条语句同时回答"新建还是覆盖"：xmax = 0 表示这一行是本次插入的
INSERT INTO user_permissions (user_id, permission_id, granted_by, granted_at, expires_at, reason)
SELECT $1, p.id, $2, $3, $4, $5 FROM permissions p WHERE p.key = $6
ON CONFLICT (user_id, permission_id) DO UPDATE
   SET granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at,
       expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason
RETURNING (xmax = 0) AS inserted;
```

- `perm_key` 不在 `permissions` 表里 → 不产生行 → `RowsAffected == 0` → 400 `admin.perm_unknown`。
- `reason` 必填（DB 有 `ck_user_permissions_reason`）。`expires_at` 建议必填，但 DB 允许 NULL——**超管临时排障需要"永久"这个选项**；若 Lead 要严格必填，把列改成 `NOT NULL`，代价是"永久授权"要用远期日期表达。
- **upsert 的语义**：同一个权限点再次授予 = 覆盖（改期限/改理由），不是报 409。管理员的意图是"把这个设成这样"，报错只会让他先删再加。
- 提交后 `InvalidateUser(ctx, targetID)`；审计 `action='permission.grant'`，detail 记 `after`（含 `inserted` 布尔）。

#### `DELETE /admin/users/{id}/permissions/{perm_key}`

```sql
DELETE FROM user_permissions up
 USING permissions p
 WHERE up.permission_id = p.id AND up.user_id = $1 AND p.key = $2
RETURNING up.granted_at, up.expires_at, up.reason;
```

删不到 → 404 `common.not_found`（"这条追加不存在"，不是"操作成功"）。审计 `action='permission.revoke'`，detail 记 `before`。提交后 `InvalidateUser`。

### 8.9 最后一个 superadmin 的守卫（唯一需要"数数"的逻辑）

```sql
-- 只在「目标用户当前是 superadmin」且「操作会让 active 超管数减少」时执行
-- 与写操作同事务，保证判定与写入之间没有窗口
WITH target AS (
    SELECT u.id, r.is_super AS was_super
      FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1
     FOR UPDATE OF u
),
remaining AS (
    SELECT count(*) AS n
      FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.is_super AND u.id <> $1 AND u.status = 'active'
)
SELECT t.was_super, (SELECT n FROM remaining) AS remaining FROM target t;
```

- `remaining = 0` → 409 `admin.last_super`。
- **状态轴也要算进去**：只有 `status = 'active'` 的超管才算"救命的那个"。否则会出现"剩下一个被封的超管，实际没人能登录"。
- **两条路都要挡**：改角色（本节上面）与**封号**（`BanUser` 对 superadmin 目标做同样的检查）。少挡一条，守卫就是摆设。
- **CLI 兜底**：`forum create-admin` 只能增加；**不提供** `forum demote-admin`——救场时用 SQL 直连改，那是运维动作，要留痕。
- **不做"禁止自我降权"**：有第二个超管时自我降权是合法操作。

### 8.10 审计写入时机与动作清单

**结论：审计与业务写操作同事务**（`WriteAudit(ctx, tx, …)` 接收 `*ent.Tx`），**不是 best-effort**。

理由：best-effort 的失败模式是"操作发生了但没有记录"，而审计的价值恰恰是"事后能查出来"。同事务的代价是"审计写失败会让业务失败"——但审计表与业务表在同一个库、同一个连接池，它挂的时候业务也写不进去，**这个代价实际不存在**。

| action | 触发 | target_type / target_id | detail |
|---|---|---|---|
| user.register | 注册 | user / public_id | `{}` |
| user.login | 登录成功 | user / public_id | `{}` |
| user.create_admin | CLI | user / public_id | `{}` |
| user.role.assign | 改基线角色 | user / public_id | `{"before":{"role":"user"},"after":{"role":"admin"}}` |
| user.ban | 封号 / 解封 | user / public_id | `{"before":{"status":"active"},"after":{"status":"banned"}}` |
| user.sessions.revoke | 管理员强制下线 | user / public_id | `{"after":{"revoked":3}}` |
| role.permissions.edit | 改角色矩阵 | role / role_key | `{"before":{"perms":[…]},"after":{"perms":[…]}}` |
| permission.grant | 追加 / 覆盖 | user / public_id | `{"after":{"perm":"user.ban","expires_at":…,"reason":"…","inserted":true}}` |
| permission.revoke | 回收 | user / public_id | `{"before":{"perm":"user.ban"}}` |
| permission.expire | cron 清理过期追加 | user / public_id | `{"before":{"perm":"user.ban","expires_at":…}}` |
| auth.password.change | 改密码 / 重置密码 | user / public_id | `{"after":{"sessions_revoked":2}}` |
| auth.email.verify | 邮箱验证码校验通过（激活） | user / public_id | `{}` |
| audit.export | 导出审计日志（**U10 定案：导出的动作自己必须留痕**） | audit_log / `<from>~<to>` | `{"after":{"rows":1234,"from":"…","to":"…","format":"csv"}}` |

**不写审计的**（写了就是噪声，会把真实事件淹掉）：登录失败（由限流计数覆盖）、登出、改昵称/简介/头像、看审计日志、**验证码校验失败**（拍板与本文都没有这一条；爆破痕迹由限流计数与邮件日志承担）。
**`audit.export` 自己在导出前写一行**（U10 定案）：它是唯一"能一次导走全站操作痕迹"的动作，不留痕等于把审计的意义反着用。于是导出的 CSV **不含**这一行（它写在读取之前）。
**`ip` 的来源**：handler 取 `c.ClientIP()`（已 SetTrustedProxies），service 的入参里带 `ip netip.Addr`，**不从 context 取**（方案 §15.26）。

---

## 9. Principal、路由与未验证用户的逐端点影响面

### 9.1 Principal 与 Actor

```go
// internal/auth/principal.go
type ctxKey struct{}          // 私有类型做 key，防别的包用字符串 key 撞车

type Principal struct {
    UserID        int64
    PublicID      string
    Nickname      string
    Digest        string       // hex(sha256(token))，登出当前设备与缓存失效用
    SessionID     int64
    CSRF          string
    EmailVerified bool
    Activated     bool
    Status        string
    AvatarHash    string
    AvatarSmall   string
    RoleID        int64
    RoleKey       string
    RoleName      string
    RoleBadge     string
    IsSuper       bool
    Perms         authz.Set
    BoardIDs      []int64
    ExpiresAt     time.Time
}

// FromGin 返回 *authz.Actor（拍板 §5.3 的 service 入参类型）；游客返回 (nil, false)
func FromGin(c *gin.Context) (*authz.Actor, bool)
```

`FromGin` 从 Principal 拷一份 Actor（`Perms` 共享同一个 Set，它是只读的）。**service 只收 Actor**，不从 context 取（方案 §15.26）。

### 9.2 路由注册

```go
func (h *Handler) Register(rg *gin.RouterGroup, authSvc *Service) {
    v := rg.Group("/api/v1")
    login     := authSvc.RequireLogin()
    activated := authSvc.RequireActivated()  // 登录 + activated_at 非空（写闸门，拍板 §9.12）

    // 认证（游客）
    v.GET ("/captcha",              h.captcha)
    v.POST("/auth/register",        h.register)
    v.POST("/auth/login",           h.login)
    v.POST("/auth/email/verify",    h.emailVerify)
    v.POST("/auth/password/forgot", h.passwordForgot)
    v.POST("/auth/password/reset",  h.passwordReset)

    // 我的账号
    v.GET   ("/me",                 h.me)                        // 游客 200 + data:null
    v.POST  ("/auth/logout",        login, h.logout)
    v.PATCH ("/me",                 login, h.updateProfile)
    v.POST  ("/me/password",        login, h.changePassword)
    v.GET   ("/me/sessions",        login, h.listSessions)
    v.DELETE("/me/sessions/:id",    login, h.revokeSession)
    v.POST  ("/auth/email/resend",  login, h.resendVerify)

    // 管理：角色与权限（提权类）
    a := v.Group("/admin", login)
    a.GET   ("/roles",                        authSvc.Perm(authz.PermRoleEdit),        h.adminListRoles)
    a.GET   ("/permissions",                  authSvc.Perm(authz.PermRoleEdit),        h.adminListPermissions)
    a.PATCH ("/roles/:id/permissions",        authSvc.Perm(authz.PermRoleEdit),        h.adminReplaceRolePerms)
    a.PATCH ("/users/:id/role",               authSvc.Perm(authz.PermRoleAssign),      h.adminSetUserRole)
    a.POST  ("/users/:id/permissions/:perm",  authSvc.Perm(authz.PermPermissionGrant), h.adminGrantPerm)
    a.DELETE("/users/:id/permissions/:perm",  authSvc.Perm(authz.PermPermissionGrant), h.adminRevokePerm)
    a.POST  ("/users/:id/ban",                authSvc.Perm(authz.PermUserBan),         h.adminBan)
    a.POST  ("/users/:id/sessions/revoke",    authSvc.Perm(authz.PermUserBan),         h.adminRevokeSessions)
    a.GET   ("/audit-logs",                   authSvc.Perm(authz.PermAuditView),       h.adminAuditList)
    a.GET   ("/audit-logs/export",            authSvc.Perm(authz.PermAuditExport),     h.adminAuditExport)
}
```

- **本域没有"写内容"路由**，所以 `RequireActivated()` 不在上面这张注册表里出现，它是给别的模块用的：**forum / media / message / reward 的写路由必须挂它**（§9.3 的 ❌ 清单就是挂载清单）。那是各自的责任，本域只提供这个中间件。
- 三个中间件的分工：`RequireLogin()`（登录）→ `RequireActivated()`（登录 + `activated_at` 非空，写操作专用）→ `Perm(...)` / `PermAny(...)`（权限点）。**顺序不能换**：先知道"你是谁"、再判"你能不能写"、最后判"你有没有这个权限"。
- `Perm(...)` 默认 AND；`PermAny(...)` 用于任一。
- **一条路由级测试**（方案 §9.8 要求）：遍历 gin 路由表，断言"除白名单外的路由都必须带 `RequireLogin`"。白名单：`/healthz`、`/readyz`、`/captcha`、`/auth/register|login|email/verify|password/forgot|password/reset`、`GET /me`、`GET /users/*`、`GET /topics*`、`GET /boards*`、`GET /site`、`GET /titles`、`GET /search`、`/img/*`。

### 9.3 未**激活**用户（`activated_at IS NULL`）的逐端点影响面

> **写闸门只有一条：`activated_at IS NULL` → 写操作 403 `auth.not_activated`**（拍板 §9.12，2026-10-13 定案）。
> `email_verified_at` **不再挡任何功能**（只影响展示与"能不能再要一个验证码"），`auth.email_unverified` 这个错误码**作废**（回写时应从方案 §21.4 删掉）。
> 判定只写一次：`RequireActivated()` 中间件（路由层）。**service 层对"写内容"的判定由业务模块自己按 `actor.Activated` 做**——本域只提供字段。

| 端点 | 未激活用户 | 依据 |
|---|---|---|
| GET /me、GET /users/{handle}、列表/详情/搜索/图片 | ✅ 可读（与游客同权） | 拍板 §9.4「未激活：能登录、能读」 |
| PATCH /me（nickname / bio） | ✅ 允许 | 改自己的资料不是"写内容" |
| POST /me/avatar、DELETE /me/avatar | ✅ 允许（**本轮改了**） | U20 定案：头像归 media，与激活轴无关；旧站把"换头像"算写操作的做法随 `auth.email_unverified` 一起作废 |
| POST /me/payment-channels、GET、DELETE | ✅ 允许（**本轮改了**） | 收款码是"我自己的展示设置"，不是内容；挡它只会让用户先去要管理员激活 |
| POST /auth/email/verify、/auth/email/resend | ✅ **必须允许**（激活的唯一出路） | 拍板 §9.6 第 4/5 种情形：未激活者要能点"重新发送" |
| POST /me/password、GET/DELETE /me/sessions、POST /auth/logout | ✅ 允许 | 账号自保动作；否则未激活用户连密码都改不了 |
| 发帖 / 回复 / issue / issue 评论 / 投票 / 收藏 / 私信 / 举报 / 打赏申报 | ❌ 403 `auth.not_activated` | 拍板 §9.12：**唯一的写闸门** |

**为什么要允许未激活者登录**（拍板 §9.12 的第 1 条理由）：不允许的话他连"重新发送验证码"都点不到（`auto_activate=true` 模式），也看不到"等待管理员激活"这条说明（`false` 模式）——登录页那两种文案（拍板 §12.5）就没有入口了。
**为什么把闸门从"邮箱验证"换成"激活"**（拍板 §9.4）：手动激活的用户 `email_verified_at` 永远是 NULL，若按邮箱验证挡，这批人激活了却仍然不能写——与本次需求直接冲突。

### 9.4 handler 模板

```go
func (h *Handler) changePassword(c *gin.Context) {
    var req ChangePasswordReq
    if !httpx.Bind(c, &req) { return }             // 绑定失败时 Bind 已经写好 400
    actor, _ := auth.FromGin(c)                    // 路由挂了 RequireLogin，一定取得到
    if err := h.svc.ChangePassword(c.Request.Context(), actor, req.toInput(c.ClientIP())); err != nil {
        httpx.Fail(c, err); return
    }
    httpx.OK(c, nil)
}
```

**`actor, _ := auth.FromGin(c)` 后面不写 if !ok**：路由上有 `RequireLogin`，取不到就是路由写错了，那是**测试要发现的东西**（§9.2 的路由级测试覆盖），不是运行时要兜的分支（拍板 §0）。**唯一例外是 `GET /me`**——它游客可访问。

### 9.5 本域端点的完整清单（含限流与幂等）

| 方法 | 路径 | 登录 | 验证 | 权限点 | 限流 key | 幂等 |
|---|---|:--:|:--:|---|---|---|
| GET | /api/v1/captcha | — | — | — | auth:captcha:ip:<ip> 10/h | — |
| POST | /api/v1/auth/register | — | — | — | auth:register:attempt:ip:<ip> 60/h + auth:register:success:ip:<ip> 3/h（失败与成功分开算） | 唯一索引 |
| POST | /api/v1/auth/login | — | — | — | auth:login:ip:<ip> 10/m、auth:login:user:<n> 5/m | **不幂等**（重复提交多开会话，见 U11） |
| POST | /api/v1/auth/logout | ✔ | 不必 | — | — | 删不到行也 200 |
| GET | /api/v1/me | — | — | — | — | — |
| PATCH | /api/v1/me | ✔ | 不必 | — | — | 只更新请求里出现的字段 |
| POST | /api/v1/me/password | ✔ | 不必 | — | auth:login:user:<n> 5/m | 成功后删全部会话 → 第二次带旧 cookie 即 401 |
| GET | /api/v1/me/sessions | ✔ | 不必 | — | — | — |
| DELETE | /api/v1/me/sessions/{id} | ✔ | 不必 | — | — | `{id}` 是 **public_id**（U13）；删不到 404 |
| POST | /api/v1/auth/email/verify | — | — | — | auth:mail:verify:user:<id> 10 次失败/15 分钟 | 码一次性；正确后该码作废，第二次 400 auth.token_invalid |
| POST | /api/v1/auth/email/resend | ✔ | 不必 | — | auth:mail:user:<id> 1/m、5/d | `auto_activate=false` → **403 auth.activation_is_manual**（策略决定，不是故障）；已验证 → 409 auth.email_already_verified；`true` 但没有发信账号 → 503 auth.mail_unavailable |
| POST | /api/v1/auth/password/forgot | — | — | — | auth:mail:ip:<ip> 5/10min | 恒 200 |
| POST | /api/v1/auth/password/verify-code | — | — | — | 同 email/verify 的按账号窗口 | 返回 reset_ticket（10 分钟、一次性），**不消费码** |
| POST | /api/v1/auth/password/reset | — | — | — | auth:mail:ip:<ip> 10/h | 消费 reset_ticket（GETDEL）；第二次 → 400 auth.token_invalid |
| GET | /api/v1/users/{handle} | — | — | — | — | — |
| GET | /api/v1/users/search | — | — | — | global:ip | limit ≤ 20 |
| PATCH | /api/v1/admin/users/{id}/role | ✔ | ✔ | role.assign | — | 重复执行结果相同 |
| POST | /api/v1/admin/users/{id}/permissions/{perm} | ✔ | ✔ | permission.grant | — | **幂等**（upsert） |
| DELETE | /api/v1/admin/users/{id}/permissions/{perm} | ✔ | ✔ | permission.grant | — | 删不到 404 |
| PATCH | /api/v1/admin/roles/{id}/permissions | ✔ | ✔ | role.edit | — | 全量替换 |
| GET | /api/v1/admin/roles · /permissions | ✔ | — | role.edit | — | — |
| POST | /api/v1/admin/users/{id}/ban | ✔ | ✔ | user.ban | — | 置目标状态（重复 200） |
| POST | /api/v1/admin/users/{id}/sessions/revoke | ✔ | ✔ | user.ban | — | 返回被踢条数（第二次 0） |
| GET | /api/v1/admin/audit-logs | ✔ | — | audit.view | — | — |
| GET | /api/v1/admin/audit-logs/export | ✔ | — | audit.export | — | — |

**管理端不需要 `RequireActivated()` 吗？** 需要，而且**必须**：拍板 §9.12 把 `activated_at` 定为唯一写闸门，而"改角色矩阵"就是写操作——一个未激活的 admin 不该能提权。挂法与其它写路由一致（`Perm(...)` 之前加 `RequireActivated()`），测试见 §18.5 第 62 条。

---

## 10. 邮箱验证码、激活、找回密码、改密码

> 本节按 **拍板 §11（2026-10-12：邮箱激活从「点链接」改成「输 6 位验证码」）** 与 **拍板 §12（2026-10-13：注册激活简化为「一个开关决定走哪条路」）** 重写。
> **拍板 §9 的两条激活路与"发不出去就降级到 manual"已作废**——那是把一个全局配置当成了每用户状态；替代它的是一条 `site_settings` 开关（§10.1）。
> 触发这次改写的三个真实故障（拍板 §11.1）：跨设备点链接必然断、邮箱网关会拦/改写链接、链接是 GET 会被安全扫描器预取消费。**6 位码把这三条一起消掉。**

### 10.1 激活模式：一个开关决定走哪条路（拍板 §12.2）

    开关：site_settings 的键 auth.registration.auto_activate（默认 true，管理员可改、不发版）

    auto_activate = true（默认）                  auto_activate = false
    ───────────────────────────────            ───────────────────────────────
    注册 → 立刻发 6 位验证码                      注册 → **不发任何邮件**
      （同步判发信能力：没有可用账号              用户以未激活状态注册
        → 503 auth.mail_unavailable，注册失败）     activated_at = NULL
    用户在「输入验证码」页输码                     管理员在后台点「激活」
      → email_verified_at = now()                 → activated_at = now()
      → activated_at = now()                      → email_verified_at **保持 NULL**
      （两根轴一起置）                             （没有码可验，这是正常的）
    能登录、能读、**能重发码**；写 403             能登录、能读；写 403；
                                                 **不能重发（没有码）**

    两种模式下写闸门完全一样：activated_at IS NOT NULL（拍板 §12.3）。

**读开关的写法（本域唯一一处 `site_settings` 读）**：

```sql
-- internal/auth/pgsql/queries.go :: const autoActivateSQL
SELECT COALESCE((SELECT value FROM site_settings
                  WHERE key = 'auth.registration.auto_activate'), 'true');
```

- **缺行 = 默认 `true`**；值只认 `"true"` / `"false"`（大小写不敏感、去空白），**其他值按 `true` 走并记一次 Warn**（默认值本来就是 true，坏值不该把全站注册变成"等管理员"）。
- **缓存 30 秒**（拍板 §12.6 第 6 条：开关切换后立刻生效，允许 ≤30 秒的读缓存）。它是一个**全局布尔**，实现就是一个 `atomic.Value` + 到期时间戳 —— **不引入第二套缓存框架**，也不进 §6.3 那个会话缓存。
- **不在迁移里插这一行的默认值**：SQL 里的 `COALESCE` 已经兜住了"首次读不到"，再插一行就是"默认值写在两处"的第二份真源。

**为什么删掉 `activation_pending`（拍板 §12.2 的三条简化）**：

1. 模式由**配置**决定，不由"发信成功与否"推断 → 那个状态**不是每用户不同的**，就不该是用户字段。用一个字段表达一个互斥状态本身没错，错的是**把它放在了用户上**。
2. **删掉"发不出去就降级到 manual"的自动逻辑**：那是"一个开关做不到、于是用两套机制兜底"。现在管理员**明确选择**模式；选了 `auto_activate=true` 却没配发信账号 → **注册接口直接 503 `auth.mail_unavailable`**，后台提示去配。**不静默降级** —— 静默降级会让管理员以为"注册走人工"是产品设计，而真实原因是配置坏了。
3. `email_verified_at` 与 `activated_at` 仍是两根轴：`auto_activate=false` 时前者永远是 NULL，**那是正常的，不是缺陷**。

### 10.2 验证码的形状与爆破上限（拍板 §11.4）

    明文     6 位数字（crypto/rand，**不用 math/rand**）
    库里     sha256(明文) 的 32 字节 → bytea（与 session token 同一套做法）
    有效期   10 分钟（verify 与 reset 同）
    单码试错 **5 次**：第 5 次失败即 consumed_at = now()，该码作废
    重发     1 次/分钟、5 次/天（限流）
    按账号   15 分钟内累计 **10 次**校验失败 → 429 auth.too_many_requests（带 Retry-After）
    失败响应 **统一「验证码不正确或已过期」**——不区分"码错"与"码过期"

**6 位数字 + 5 次尝试 + 10 分钟 = 单码被猜中概率 5/1,000,000**，再加按账号限流，够用（拍板 §11.4 的原话）。
**邮件正文里没有链接**（拍板 §11.2）：只有 6 位数字 + 有效期说明。**提示码不做**（拍板 §11.5）。

**三样「验证码」不要混**（拍板 §11.6）：**邮箱验证码**存 `email_tokens`（本节）、**图形验证码**存 Redis `captcha:<id>`（§9.5）、**会话 token** 存 `sessions`（§6）。三者的有效期、失败计数、存储位置都不同，实现上不许合并。

### 10.3 发码（注册时与重发）—— 一次 upsert

```sql
INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at, consumed_at, attempt_count, last_attempt_at)
VALUES ($1, $2, 'verify', $3, NULL, 0, NULL)
ON CONFLICT (user_id, purpose) WHERE consumed_at IS NULL
DO UPDATE SET token_hash = EXCLUDED.token_hash,
              expires_at = EXCLUDED.expires_at,
              attempt_count = 0,          -- 新码从零开始数
              last_attempt_at = NULL,
              created_at = now();
```

- **重发的语义是"作废旧的、发新的"**：`token_hash` 一换，旧码立刻失效（不是两条都有效）。这正是拍板 §11.2 要求的行为，也是 `uq_email_tokens_live` 存在的理由。
- **`attempt_count` 必须清零**：否则用户重发一次仍然只剩 0 次机会。
- **不在事务里发邮件**：`Queue.Enqueue` 在提交之后（方案 §14.6）。邮件任务重试时码不变（payload 只有 id），重跑只会重发同一封。
- **邮箱不可用（一个账号都没有）**：**注册请求同步返回 503 `auth.mail_unavailable`，整个注册回滚（账号不建）**。理由：`auto_activate=true` 模式下没有码就等于把用户永久卡在未激活态，那比"请管理员先配发信账号"更糟；而且删掉 `activation_pending` 之后，"账号建了但没发码"这个状态**已经没有任何字段能表达它**，留一个孤儿用户是纯粹的坏账。
  **判定顺序：先问发信能力，再开事务**（拍板 §12.2 第 2 条：不静默降级）。「额度满」不算不可用（额度会恢复，只是晚几分钟到），照常发。

### 10.4 校验验证码 `POST /api/v1/auth/email/verify`

入参 `{ username | email, code }`（拍板 §11.3；两者都不给或都给 → 400 `common.invalid_input`）。

**第一步：按账号/邮箱取那条活跃的码**（复用 §7.2 的 `findUserByLoginSQL`，`lower(col) = lower($1)`）。查不到账号也要走一次哑校验（恒时，同 §7.2 的做法），否则"这个账号存不存在"会从响应时间里漏出去。

**第二步：分两支，都在一个事务里**

```sql
-- 支 A：码正确。一条语句同时完成「消费该码」「置验证时间」「激活」
UPDATE email_tokens t
   SET consumed_at = $3
  FROM users u
 WHERE t.user_id = $1
   AND t.purpose = 'verify'
   AND t.token_hash = $2
   AND t.consumed_at IS NULL
   AND t.expires_at > $3
   AND t.attempt_count < 5
   AND u.id = t.user_id
RETURNING t.id;

UPDATE users
   SET email_verified_at = $3, activated_at = $3, updated_at = $3
 WHERE id = $1;

DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'verify' AND consumed_at IS NOT NULL;

INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
VALUES ($1, 'auth.email.verify', 'user', $4, '{}'::jsonb, $5);
```

```sql
-- 支 B：码不正确（或过期、或已被 5 次作废）。一条语句完成「计数 +1」「第 5 次时作废」
UPDATE email_tokens
   SET attempt_count = attempt_count + 1,
       last_attempt_at = $3,
       consumed_at = CASE WHEN attempt_count + 1 >= 5 THEN $3 ELSE consumed_at END
 WHERE user_id = $1
   AND purpose = 'verify'
   AND consumed_at IS NULL
RETURNING attempt_count;
```

**两条必须讲清的性质**：

1. **判据只写在 WHERE 里，不先 SELECT 再 UPDATE**——两个并发请求都能在第一支里胜出，靠的是条件 UPDATE 的原子性（第二个的 `consumed_at IS NULL` 已经不成立）。
2. **支 A 与支 B 的区分就在 `RETURNING` 有没有行**：支 A 没更新到行 → 说明码不对/过期/已作废 → 走支 B 计数，然后**统一**返回 400 `auth.token_invalid`（对外文案「验证码不正确或已过期」）。**绝不在响应里区分是哪种情况**（拍板 §11.4）。

**限流**（在事务之前判，避免给爆破者省事）：

    键   auth:mail:verify:user:<user_id>     窗口 15 分钟
    值   累计校验失败次数；达到 10 → 429 auth.too_many_requests + Retry-After
    成功一次 → 计数清零（用户已经证明了他有邮箱）

3. **已激活的用户又输了一次码**（管理员先手动激活、用户随后才拿到码）：支 A 会把 `email_verified_at` 与 `activated_at` 都刷新成更晚的时间。**无害**（两根轴只是被写晚了一次），但要在测试里固定住（§18.4），否则以后有人会把它当 bug 去"修"。
4. **失败不写审计**：拍板与 §8.10 的动作清单里都没有"验证码校验失败"这一条。爆破痕迹由限流计数与邮件日志承担；写进审计只会把真实事件淹掉。

### 10.5 重发验证码 `POST /api/v1/auth/email/resend`

    1. auto_activate = false → **403 auth.activation_is_manual**（本站按配置就是不发邮件，重试无意义）
    2. 限流 auth:mail:user:<id> 1 次/分钟、5 次/天 → 429 auth.too_many_requests + Retry-After
    3. 已经 email_verified_at 非空 → 409 auth.email_already_verified
    4. 同步查有没有可用发信账号 → 没有：503 auth.mail_unavailable（**不改任何用户状态**）
    5. 有 → §10.3 的 upsert（新码顶旧码）；提交后 Enqueue mail:send
    6. 响应：200 + `resend_after`（秒，前端拿它做倒计时）；**不返回任何"模式"字段**

**两种模式下的语义**（拍板 §12.2 的表格 + §12.5 的前端那行）：

- `auto_activate=true`：正常重发，旧码立刻失效；
- `auto_activate=false`：**没有码可发** → 503。前端在"等待管理员激活"那种文案下**不显示重发按钮**（拍板 §12.5），这个 503 是"后端不信任前端"的那一半，不是主路径。

**为什么这里必须是 403 + 一个专门的码（U22 定案，2026-10-13）**：这不是服务故障，是**策略决定**——客户端不该重试，运维也不该去查发信系统。所以：

| 情形 | 码 | 状态 | 含义 | 谁该动 |
|---|---|---|---|---|
| `auto_activate=false`，用户请求重发 | `auth.activation_is_manual` | **403** | 本站采用管理员激活，没有码可发 | **没人**（这是产品选择） |
| `auto_activate=true` 但没有可用发信账号 | `auth.mail_unavailable` | **503** | 发信系统出问题了 | **管理员**（去配发信账号） |

**两个码不能合并**：它们一个是"配置错了"、一个是"产品就是这样"。合并之后，同一句"发不出验证码"会让运维分不清该不该去修 —— 这正是本项目一直在清的那类"一个东西顶两件事"。文案：`auth.activation_is_manual` = 「本站当前采用管理员激活，不需要验证码」。

### 10.6 找回密码（也是验证码，两步一页）

`POST /api/v1/auth/password/forgot`：

    1. 限流 auth:mail:ip:<ip> 5 次/10 分钟（2026-10-16 与注册同批放宽）
    2. 查账号行（复用 findUserByLoginSQL，参数是 body.email）
    3. **无论查到与否都 200**（方案 §21.2：不暴露邮箱是否存在），且响应体除 request_id 外逐字节相同
    4. 查到但 status='banned' → 不发码，照样 200
    5. 查到 → §10.3 的 upsert（purpose='reset'）+ 提交后 Enqueue mail:send

**码只进邮件正文，不进日志、不进响应体。**

`POST /api/v1/auth/password/reset` 是**两步**（拍板 §11.7 的前端流程是「输入验证码 → 设新密码」）：

    第一步：POST /api/v1/auth/password/verify-code { username|email, code }
            → 校验同 §10.4（同一个 purpose='reset' 的码、同一套 5 次上限与限流）
            → **不消费码**，返回 { reset_ticket }：Redis 里 auth:pwreset:<ticket> = user_id，TTL 10 分钟
    第二步：POST /api/v1/auth/password/reset { reset_ticket, new_password }
            → 消费票据（GETDEL，一次性）→ 一个事务：
                 UPDATE users SET password_hash, updated_at
                 DELETE FROM sessions WHERE user_id RETURNING token_hash
                 UPDATE email_tokens SET consumed_at = now() WHERE user_id AND purpose='reset' AND consumed_at IS NULL
                 INSERT INTO audit_logs('auth.password.change', after={sessions_revoked:n})

**为什么中间要一张票据**：6 位码只有 10 分钟且只能错 5 次，而"想新密码 + 打字 + 确认"是人来做的，很容易超过 10 分钟；票据把"证明了我有邮箱"与"设置新密码"解耦，码在第一次校验后就不再需要（但**不提前消费**——提前消费会让用户输错新密码格式后再也回不去）。
**票据不落库**：它是 10 分钟的临时凭据，放 Redis（`kv`）而不是又一张表；`GETDEL` 保证只用一次。**拍板 §10.8 第 5 条把「reset 改验证码制」列为待拍板**——本节的写法就是那条的落地，若 Lead 选另一条路（保留链接），改动只在 §10.6 这一段。

**哈希在事务外算**（同 §7.1 第 3 步）。**失败停在什么状态**：要么全成，要么什么都没变（同一个事务）。不存在"密码改了但会话没删"的中间态。

### 10.7 默认头像的分配（U12 定案，本域只提供列）

```sql
-- 读路径：hash 为 NULL 时按 id 取模（这一步不写库）
SELECT hash FROM default_avatars ORDER BY sort, hash OFFSET ($1 % (SELECT count(*) FROM default_avatars)) LIMIT 1;

-- 首次分配：写回一列，此后固定不变（旧站「随机分一次就固定」的语义）
UPDATE users SET default_avatar_hash = $2, updated_at = $3
 WHERE id = $1 AND default_avatar_hash IS NULL;
```

- **`AND default_avatar_hash IS NULL` 是这条语句的全部要点**：并发两次请求只会有一行被写上，第二个的 `RowsAffected = 0` 是无害的（它本来就该拿到同一个值吗？不——它拿到的是**同一个** hash，因为选择基于 `users.id` 而不是随机数）。**不用随机**：旧站是"随机分一次就固定"，用 id 取模能达到同样的"固定"效果且没有并发窗口。
- **谁写这一列**：写路径（media 的读/写路径）负责；本域只保证列存在、有索引、`ON DELETE SET NULL` 在池子条目被删时把引用清空。
- **池子为空**（`default_avatars` 没有行）：返回空字符串，由前端显示首字母占位。**不要**为这个分支加兜底图。

### 10.6 改密码 `POST /api/v1/me/password`

    1. 事务外：取账号行（按 actor.UserID，走主键）、取信号量、恒时校验 old_password、算新哈希
    2. 校验失败 → 401 auth.bad_credentials（不改密码，也不删会话）
    3. 新密码与旧密码相同 → 400，fields.new_password
    4. WithTx：UPDATE users SET password_hash + DELETE FROM sessions WHERE user_id（**含当前会话**）
    5. 提交后：InvalidateSession（当前摘要）+ ClearCookie + 200

**为什么把当前会话也删掉**：方案 §9.2 定的就是"改密码时删除该用户的全部 Session"，语义也对——改密码意味着所有地方重新登录。
**必须断言**：改密码成功后，带**同一个** cookie 请求 `GET /me` 得到 `data: null`。

---

## 11. user 模块：公开资料

### 11.1 `GET /api/v1/users/{handle}` 的聚合查询

```sql
-- internal/user/pgsql/queries.go :: const profileSQL
SELECT u.id, u.public_id, u.username, u.nickname, u.bio,
       u.avatar_hash, u.avatar_small_hash,
       u.exp, u.level, u.status,
       u.created_at AS joined_at,
       t.id AS title_id, t.name AS title_name, t.color AS title_color,
       COALESCE(tc.n, 0) AS topic_count,
       COALESCE(lc.n, 0) AS like_received
  FROM users u
  LEFT JOIN titles t ON t.id = u.equipped_title_id
  LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM topics tp
         WHERE tp.author_id = u.id AND tp.visibility = 'normal' AND tp.review_state = 'approved'
       ) tc ON true
  LEFT JOIN LATERAL (
        SELECT count(*) AS n
          FROM likes l JOIN posts p ON p.id = l.target_id AND l.target_type = 'post'
         WHERE p.author_id = u.id AND p.status = 'normal'
       ) lc ON true
 WHERE lower(u.username) = lower($1);
```

**EXPLAIN 预期**：`Index Scan using uq_users_username_lower`（rows=1）→ `Index Scan using titles_pkey`（0..1）→ 两个 LATERAL：`idx_topics_author` 与 `idx_likes_target`。
**这是本域唯一一条随数据量线性增长的查询**——诚实记账见 §16.5。
**`lower(u.username) = lower($1)` 逐字一致**（拍板 §5.9 第 2 条）。
**`u.status` 不过滤**：封禁用户的公开页仍可访问（响应里带 `status`）；404 掉它会让"点老帖作者头像得到 404"，那是更差的体验。**但 `status='deleted'` 时返回 404**。两条都要测。

### 11.2 响应形状（`GET /users/{handle}`）

```json
{ "data": {
    "id": "0192…", "handle": "tangtian", "nickname": "唐天",
    "avatar": "/img/ab/cd/…", "avatar_small": null,
    "bio": "…", "status": "active",
    "level": 3, "exp": 1200, "exp_max": 1600,
    "topic_count": 42, "like_received": 318, "joined_at": "2026-01-02T03:04:05Z",
    "title": { "name": "资深作者", "color": "#2563eb" }
} }
```

- `exp_max` 由后端算（界面施工 §2.5）：不变量公式只能有一处实现（§12）。
- `title` 只给**佩戴中**的那一个；没有佩戴时为 `null`。持有的全部头衔在 `GET /users/{handle}/titles`（title 模块）。
- `id` 是 public_id；`avatar` 是 `/img/<hash>` 路径——本域只回 hash，路径由 media 的 URL 生成器拼（U15/U20）。

### 11.3 handle 唯一性与查询写法（把这条刻在墙上）

    ✅ WHERE lower(username) = lower($1)     -- 走 uq_users_username_lower
    ❌ WHERE username = $1                   -- 大小写不同就查不到
    ❌ WHERE lower(username) = $1            -- 参数没 lower()，表达式对不上 → Seq Scan
    ❌ WHERE username ILIKE $1               -- 同上

**handle 是"登录名"的对外叫法**（URL 用 `{handle}`，库里叫 `username`）。注册**不做**保留字黑名单：`/users/{handle}` 与 `/admin/*` 前缀已经分开。

### 11.4 `GET /api/v1/users/search?q=`（@ 提及候选，20.2 第 7 条）

    q 长度 1..32；limit 默认 10、上限 20（超出按 20）
    匹配：nickname 前缀 OR username 前缀（两边都 lower()）
    排序：nickname 完全相等 → username 前缀命中 → nickname 前缀命中 → username ASC
    重名标记：返回集合里同一 nickname 出现 ≥2 次 → 这些行 ambiguous = true

```sql
-- internal/user/pgsql/queries.go :: const searchUsersSQL
SELECT u.public_id, u.username, u.nickname, u.avatar_hash, u.avatar_small_hash, u.level,
       (count(*) OVER (PARTITION BY lower(u.nickname))) > 1 AS ambiguous
  FROM users u
 WHERE u.status = 'active'
   AND (lower(u.username) LIKE lower($1) || '%' OR lower(u.nickname) LIKE lower($1) || '%')
 ORDER BY (lower(u.nickname) = lower($1)) DESC,
          (lower(u.username) LIKE lower($1) || '%') DESC,
          u.username ASC
 LIMIT $2;
```

**它需要一条只为它建的索引**：

```sql
CREATE INDEX idx_users_nickname_lower ON users (lower(nickname) varchar_pattern_ops) WHERE status = 'active';
```

- **`varchar_pattern_ops` 不能省**：默认 operator class 只在 `lc_collate = 'C'` 时支持 LIKE 前缀优化。
- 谓词只放列（`status='active'`），符合拍板 §5.9 第 1 条。
- **EXPLAIN 预期**：`BitmapOr`（`uq_users_username_lower` 范围扫 + `idx_users_nickname_lower` 范围扫）。
- `ambiguous` 用窗口函数在同一次扫描里算出，不额外查一次。
- 空结果不是错误（前端显示"没有匹配的用户"）。

### 11.5 user 模块不做的事

| 不做 | 原因 |
|---|---|
| `PATCH /me`、头像、收款码 | 写在 auth 的 `/me` 路由里（同一条事务边界，§4.1） |
| `GET /users/{handle}/topics` | 属 D3（forum）；本域只给 profile 聚合 |
| 昵称/正文的模糊搜索（前后缀都通配） | `GET /search?type=users` 是 D5 的搜索域；本域只做**前缀**候选 |

---

## 12. 等级与经验的不变量

    不变量：users.level = floor(sqrt(users.exp / 100)) + 1
    exp = 0 → level 1 ｜ exp = 99 → 1 ｜ exp = 100 → 2 ｜ exp = 400 → 3 ｜ exp = 900 → 4
    下一级门槛：exp_max = level * level * 100        （level 1 → 100，level 2 → 400）

**在哪算**：只在 `internal/title`（经验与头衔模块）——**本域不提供 AddExp**，只提供自检与 `exp_max` 的算法。
**什么时候写**：**写 exp 的同一个事务里把 level 一起 UPDATE**（数据库文档 §4.11），不做后台补算。

```sql
UPDATE users
   SET exp = exp + $2,
       level = floor(sqrt((exp + $2) / 100.0)) + 1,
       updated_at = $3
 WHERE id = $1
RETURNING exp, level;
```

**`/ 100.0` 必须带小数点**：整数除法在这一族公式上看起来碰巧不出错，但"碰巧"不是设计，代价是零，别省。
**`exp_max` 由后端算**（§11.2），与上面同源。

**自检 SQL**（数据库文档 §12 第 5 条，落在本域）：

```sql
SELECT id, exp, level, floor(sqrt(exp / 100.0)) + 1 AS expected
  FROM users
 WHERE level <> floor(sqrt(exp / 100.0)) + 1
 LIMIT 100;
```

**测试覆盖九个点**：`exp ∈ {0, 99, 100, 101, 399, 400, 401, 9999, 10000}` → level = {1,1,2,2,2,3,3,10,11}。

---

## 13. 审计端点

### 13.1 `GET /api/v1/admin/audit-logs`（`audit.view`）

参数：`?actor=<public_id>&action=&target_type=&from=&to=&limit=&cursor=`（界面施工 §5.4）。
游标：`(created_at DESC, id DESC)`，`base64url(JSON{k:<RFC3339Nano>,id:<自增 id>})`。
**游标里的自增 id 不违反拍板 §5.6**：游标是不透明字符串，前端只回传不解释，它没有出现在任何"对外 ID"字段里。

```sql
-- internal/auth/pgsql/queries.go :: const listAuditSQL
-- 所有筛选项都在的版本；实现时按实际出现的筛选项用 ent 的 predicate 组装（不拼用户输入）
SELECT a.id, a.created_at, a.action, a.target_type, a.target_id, a.detail, a.ip,
       u.public_id AS actor_public_id, u.nickname AS actor_nickname, u.username AS actor_handle
  FROM audit_logs a
  LEFT JOIN users u ON u.id = a.actor_id
 WHERE ($1::text  IS NULL OR a.target_type = $1)
   AND ($2::text  IS NULL OR a.target_id   = $2)
   AND ($3::text  IS NULL OR a.action      = $3)
   AND ($4::bigint IS NULL OR a.actor_id   = $4)
   AND ($5::timestamptz IS NULL OR a.created_at >= $5)
   AND ($6::timestamptz IS NULL OR a.created_at <  $6)
   AND ($7::timestamptz IS NULL OR (a.created_at, a.id) < ($7, $8))
 ORDER BY a.created_at DESC, a.id DESC
 LIMIT $9;
```

**EXPLAIN 预期**：只有 `from/to` → `Index Scan Backward using idx_audit_logs_dump`；只有 `actor` → `idx_audit_logs_actor`；只有 `target_*` → `idx_audit_logs_target`。三种都不排序整表。

### 13.2 `GET /api/v1/admin/audit-logs/export?format=csv`（`audit.export`，单列）

    format 只允许 csv（别的值 400）
    from/to 必填（默认最近 30 天）；单次最多 50000 行（limit 只能下调）
    响应 text/csv; charset=utf-8 + Content-Disposition: attachment; filename="audit-<yyyyMMdd-HHmm>.csv"
    列：created_at, actor_handle, action, target_type, target_id, ip, detail(JSON)

**实现要点（四条，都有翻车史）**：

1. **分批取、边写边发**：每批 1000 行（`(created_at,id) < 游标`），不要一次 FetchAll——5 万行 JSON 会吃掉几十 MB，而 small 档只有 2GB。
2. **开头写 UTF-8 BOM**，否则中文 Windows 的 Excel 打开是乱码。
3. **CSV 注入防护**：以 `=`、`+`、`-`、`@`、制表符开头的单元格前加一个单引号。`detail` / `target_id` 里全是用户可控内容。
4. **它是唯一直接写 `c.Writer` 的端点**，不走 `httpx.OK`——写进 handler 注释，否则后人会"顺手统一"成 JSON 包装。

---

## 14. 启动自检（四条，全部要能跑、都要能红）

### 14.1 权限点一致性（代码常量 == permissions.key）

```go
// internal/auth/schema_check.go
// 代码有、表里没有 → 启动失败；表里有、代码没有 → slog.Warn
func (s *Service) CheckPermissions(ctx context.Context) error {
    rows, err := s.db.Permission.Query().Select(permission.FieldKey).All(ctx)   // ent 读全表
    // 双向 diff；返回 error 时附上两边的差集
}
```

**为什么代码有表里没有要启动失败**：那个权限点永远判不过（`Perms` 里不会有它），结果是**一条静默失效的鉴权**。
**为什么反向只 Warn**：库里多一行不影响任何判定，但值得提醒它指向一个已删的权限点。
**跑在哪**：`forum run` 启动序列里，**迁移版本检查之后、开始监听之前**。

### 14.2 枚举值域一致性（CHECK ↔ Go 常量）

```go
var enumChecks = []struct {
    table, column string
    want          []string
}{
    {"users", "status", []string{"active", "banned", "deleted"}},
    {"email_tokens", "purpose", []string{"verify", "reset"}},
}

func (s *Service) CheckEnums(ctx context.Context) error {
    for _, ec := range enumChecks {
        var def string
        err := s.db.QueryRowContext(ctx, `
            SELECT pg_get_constraintdef(c.oid)
              FROM pg_constraint c
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.conrelid = $1::regclass AND c.contype = 'c' AND a.attname = $2`,
            ec.table, ec.column).Scan(&def)
        got := quotedLiterals(def)          // 正则抠出所有字面量
        if !sameSet(got, ec.want) {
            return fmt.Errorf("枚举不一致 %s.%s: 迁移=%v 代码=%v", ec.table, ec.column, got, ec.want)
        }
    }
    return nil
}
```

**正则必须同时认单引号与双引号**：`pg_get_constraintdef` 在某些设置下会输出双引号，写死单引号会在真库上**静默比不过**（检查通过但什么都没查）——这是本域最危险的一类自检 bug，测试里必须拿一条真的双引号 CHECK 定义当夹具（§18.7 第 81 条）。

**`roles.key` 有自己的一条**（它不是 CHECK 列）：四个 key 必须存在，且权限数分别是 **3 / 8 / 18 / 25**：

```sql
SELECT r.key, (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS n
  FROM roles r WHERE r.key IN ('user','creator','admin','superadmin');
```

数字对不上 → **Warn 不失败**：生产上管理员合法地调过矩阵也会触发它，不该因此拒绝启动；但它能回答"迁移数据被谁改过"。

### 14.3 外键索引检查（数据库文档 §12 第 1 条的原文，能红）

```sql
SELECT c.conrelid::regclass AS tbl, c.conname, a.attname
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
 WHERE c.contype = 'f'
   AND NOT EXISTS (
     SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND i.indisvalid
        AND i.indpred IS NULL
        AND (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] @> c.conkey
   );
```

有结果即失败，**打印 tbl / 约束名 / 列名**（原文只打前两列，加 `a.attname` 才知道该补哪一列）。
三件必须照做的事：① `indisvalid` 与 `indpred IS NULL` 不能省，否则部分索引会被误判为已覆盖；② 复合主键的第二列不算已索引（`role_permissions.permission_id`、`board_moderators.user_id`、`bookmarks.topic_id`、`topic_images.topic_id`）；③ **CI 里放一份负例夹具证明它真会红**（空库跑通不算验收）。
**`user_permissions` 故意没有指向 users 的外键**（提权记录不能因为删用户而消失），所以这条检查不会要求它建 `(user_id)` 索引——这不是漏（§5.7）。

**跑在哪**：`forum check` 与 CI，**不在 `forum run` 里**。它覆盖全库的表，所以 D3/D4 漏了索引会在这里被报出来——报错信息必须带表名。

### 14.4 迁移版本一致

不属于本域（数据库文档 §12 第 2 条，D1 的启动序列）。**本域自检注册在它之后**：迁移没对齐就先拒绝启动，不要跑到权限检查。

---

## 15. 错误码（对照方案 §21.4 总表）

### 15.1 复用（一个都不改）

| code | 状态 | 本域用在哪 |
|---|---|---|
| common.invalid_input | 400 | 参数校验失败（带 fields） |
| common.unauthorized | 401 | 未登录；封号后的旧 Cookie |
| common.forbidden | 403 | 已登录但缺权限 |
| ~~auth.email_unverified~~ | ~~403~~ | **已作废**（拍板 §9.12）：写闸门只有 `auth.not_activated` 一个。留着这一行只是为了让实现者知道"看到这个码不要用" |
| common.not_found | 404 | 会话/令牌/用户不存在（**公开接口一律用它**，别用 admin.user_not_found 去泄露"这个人存在但被封了"） |
| common.conflict | 409 | 唯一索引冲突（lower(username) / lower(email) / uq_email_tokens_live） |
| common.rate_limited | 429 | 限流；带 Retry-After |
| auth.bad_credentials | 401 | 登录失败、改密码时旧密码错（不区分哪个错） |
| auth.captcha_required / auth.captcha_wrong | 400 | 方案 §9.5 |
| auth.token_invalid | 400 | 邮箱/重置令牌无效、过期、已用过 |
| common.internal | 500 | 兜底 |

### 15.2 本域新增（**15 个**：12 个自己造的 + 3 个拍板点名的，方案 §21.4 总表里没有，**建议 Lead 回写总表**）

| code | 状态 | 出现场景 | 为什么不能复用现成的 |
|---|---|---|---|
| auth.handle_taken | 409 | 注册时 lower(username) 撞车 | 用 common.conflict 则前端无法把错误挂到 username 输入框上 |
| auth.email_taken | 409 | 注册时 lower(email) 撞车 | 同上 |
| auth.email_already_verified | 409 | 对已验证账号请求重发验证邮件 | common.conflict 说不出"你已经验证过了" |
| auth.hash_busy | 503 | argon2 信号量等 3 秒仍未拿到 | 429 是"你太快"，503 是"我处理不了"；运维靠它区分（方案 §9.1 写的就是 503） |
| auth.email_taken_by_other | 409 | 已登录用户请求改邮箱而目标邮箱被占 | 与注册的 auth.email_taken 分开：这个场景要提示"换一个邮箱"而不是"去登录" |
| admin.user_not_found | 404 | 管理端按 public_id 找用户找不到 | 管理端与公开接口的 404 混用同一个码，排障时看不出是哪一侧 |
| admin.role_not_found | 404 | 目标角色不存在 | 同上 |
| admin.role_system | 409 | 改/删内置角色（is_system=true）的 key 或删除 | 要能提示"内置角色不可删" |
| admin.role_in_use | 409 | 删还有用户在用的角色（FK RESTRICT） | 要能提示"先把这个角色的人改到别的角色" |
| admin.last_super | 409 | 降权或封禁最后一名 active 的 superadmin | **必须有自己的码**：前端要显示"这是最后一名超管"的专用提示 |
| admin.perm_unknown | 400 | 追加权限时 perm_key 不在 permissions 表里 | 参数错，但错在枚举值域不是格式，前端要提示"权限点不存在" |
| auth.not_activated | 403 | 未**激活**用户的写操作（拍板 §9.4 / §9.12；**唯一的写闸门**） | 它要能单独挂到"去激活"那条引导上，用 common.forbidden 前端分不出"没权限"与"还没激活" |
| auth.activation_is_manual | 403 | `auto_activate=false` 时请求重发验证码（拍板 §12.2 定案，U22） | **403 而不是 503**：这是**策略决定**（本模式没有码），不是服务故障，客户端不该重试；也要与 `auth.mail_unavailable` 分开——那个是"配置错了，该去修" |
| auth.mail_unavailable | 503 | `auto_activate=true` 但**没有可用发信账号**（注册时同步返回，注册回滚） | 它是**配置错了**：503 表示"现在做不了，修好就能做"，运维该去配发信账号。**额度满不算**（额度会恢复） |
| auth.too_many_requests | 429 | 重发超限，以及 15 分钟内累计 10 次验证码校验失败（拍板 §11.4；带 Retry-After） | 与 common.rate_limited 并存：**拍板点名的场景用这个**，图形验证码/登录/注册等旧场景仍用 common.rate_limited（回写时把这条差异写进方案 §21.4） |

**不新增的**：user.not_found（配套的 `GET /admin/users/{id}` 归独立 admin 模块，见 U14）、令牌与重发的细分错误（用 auth.token_invalid 一条覆盖——**"码错"与"码过期"必须同一个响应**，拍板 §11.4）。

---

## 16. 设计时必须先回答的四个问题

### 16.1 数据量上来之后还走索引吗（EXPLAIN 预期）

| 查询 | 计划 | 行数 | 与表大小的关系 |
|---|---|---|---|
| Resolve（§6.2） | 4× Index Scan：uq_sessions_token → users_pkey → roles_pkey → idx_board_moderators_user | 1 / 1 / 1 / 0..3 | **无关** |
| loadActor（§8.3） | 6× Index Scan：users_pkey → roles_pkey → role_permissions_pkey → idx_user_permissions_user → idx_board_moderators_user → permissions_pkey | 1 / 1 / ≤24 / ≤5 / ≤3 / 24 | **无关**（roles 与 permissions 是常数级表） |
| findUserByLogin（§7.2） | BitmapOr：uq_users_username_lower + uq_users_email_lower | ≤2 | 无关 |
| profile（§11.1） | uq_users_username_lower → titles_pkey → idx_topics_author → idx_likes_target ×N | 1 / ≤1 / 该用户主题数 / 该用户帖子数 | **线性**，见 §16.5 |
| searchUsers（§11.4） | BitmapOr：uq_users_username_lower 范围 + idx_users_nickname_lower 范围 | 命中数 | 无关 |
| listAudit（§13.1） | idx_audit_logs_dump Backward / _actor / _target | 时间窗内行数 | 无关（管理员动作的量级） |
| 会话列表 GET /me/sessions | idx_sessions_user | 该用户的会话数 | 无关 |
| 清理任务（§16.5） | sessions / email_tokens 全表扫（分批 LIMIT） | 见 §16.5 | **线性，且是有意的** |
| 后台用户列表（D2 之外，但用同一张表） | **Seq Scan（接受）** | users 行数 | 线性，见 §16.5 |

**验证方式**：CI 里对上面每条跑 `EXPLAIN (ANALYZE, BUFFERS)`，断言 sessions / users / audit_logs / role_permissions 上**没有 Seq Scan**（表小于 1000 行豁免——数据库文档 §12 第 11 条）。

### 16.2 并发重放会发生什么

| 操作 | 双击提交 / 重放两次 | 两个管理员同时操作 |
|---|---|---|
| 注册 | 第二次撞唯一索引 → **409 auth.handle_taken / auth.email_taken** | — |
| 登录 | **会开出两个会话**（不是 bug，见 U11） | — |
| 登出 | 第二次删不到行 → 仍 200 | — |
| 改密码 | 第二次带的是旧 cookie → 401（会话已删） | — |
| 重置密码 | 令牌 used_at 已写 → 第二次 400 auth.token_invalid | — |
| 邮箱验证 | 第二个请求 RowsAffected = 0 → 400 | — |
| 追加权限 | upsert 幂等，第二次同样成功（审计两条 —— **这是对的**） | 两事务插同一主键 → 第二个阻塞到第一个提交 → ON CONFLICT DO UPDATE 覆盖；两边审计都留痕 |
| 回收权限 | 第二次删不到 → 404 | 同上 |
| 改角色 | 第二次结果相同（不报错）；审计两条 | `FOR UPDATE OF u` 串行化；改的是同一个人，不会"超卖" |
| **降权最后一个超管** | 第二次：remaining 已是 0 → 409 admin.last_super | 两事务锁同一目标行 → 串行；第二个看到 remaining=0 → 409。**不会两人同时成功** |
| 封号 | 置目标状态，重复 200 | 与降权同一个守卫（封 superadmin 要走 remaining 检查） |
| 改角色权限矩阵 | 全量替换 → 重放结果相同 | 两事务往 role_permissions 同一集合插入 → 有主键冲突与死锁风险。**缓解**：INSERT 的 SELECT 带 `ORDER BY p.id`（同一加锁顺序）+ 先锁 role 行（§8.8 的 SQL 已含 `FOR UPDATE`） |

### 16.3 失败之后数据停在什么状态（有没有人要手工修）

| 失败点 | 数据状态 | 要人修吗 |
|---|---|---|
| 注册事务里任何一步失败 | 回滚：没有用户行、没有令牌行、没有审计行 | 不用 |
| 注册提交了但入队（发验证邮件）失败 | 用户存在、未验证、没有邮件 | **不用**：用户点"重发"。这就是"事务里不发邮件"的代价与收益 |
| 登录时 rehash 写回失败 | 整事务回滚：没建会话，500 | 不用，重试即可 |
| 审计写入失败 | 与业务同事务 → **业务也回滚** | 不用。**这正是"同事务"买来的性质**：不存在"操作发生了但没记录" |
| InvalidateUser 失败 | 权限在 ≤60 秒内不生效 | **不用**：epoch 的 INCR 是唯一动作，DEL 失败也最多让旧条目多活一次请求；TTL 到期自愈 |
| 提交后清 Cookie 失败 | 客户端还带着坏 token | 不用：下一请求仍解析失败 → 当游客 |
| 密码重置事务中删会话失败 | 整事务回滚：密码没改、令牌仍可用 | 不用 |
| 降权/封号守卫拒绝 | 什么都没变 | 不用 |
| 迁移数据与代码常量不一致 | **拒绝启动** | **要人修**：补迁移或删常量。这是有意的"停服比静默错好" |
| 磁盘满 / PG 挂 | 所有写失败，事务回滚 | 要人修（运维） |
| 审计列表/导出失败 | 只读，无影响 | 不用 |

### 16.4 这段代码不写会少什么

见 §0 的表。补三条最容易漏的：

- **不写 uq_roles_super**：会出现两个 is_super 角色，"超管"从"某一个角色"变成"某一批角色"，§8.9 的守卫就要按角色集合判——难度与出错面都上一个台阶。一条部分唯一索引买下这件事。
- **不写 ck_sessions_hash_len**：有人把 token 明文或 hex 文本写进 token_hash 时，功能**照常工作**（查询一样命中），但库里从此躺着可直接使用的凭据。这条 CHECK 是唯一能在入库那一刻拦住它的东西。
- **不写 §13.1 的 actor 筛选**：界面施工 §5.4 明确要按 actor 筛选；没有它，管理员只能翻全表找"是谁把这个人的权限改了"——而按人查就是审计的实际使用方式。

### 16.5 已知的性能边界（诚实记账，不是"待优化"）

| 边界 | 现在的量级 | 什么时候要动 |
|---|---|---|
| profile 的 like_received 是 LATERAL 子查询（每个帖子查一次赞数） | 100 帖 → 100 次索引查找，约 1–3ms | 出现单用户 >1000 帖时改成物化计数列（**那时它是第二份真源，必须配一条 §14 的自检**） |
| 后台用户列表 `q` 是前后缀模糊 | users 全表扫，1 万行约 5ms | users >5 万行时加 pg_trgm GIN 索引（现在**不加**：为一个每天跑十几次的管理员查询加三条索引不值） |
| 会话/令牌清理任务 | 每小时删"过期 ≥7 天"的行；`DELETE ... WHERE ... LIMIT 5000` 循环到删空 | sessions >100 万行时改成按主键范围分片扫 |
| epoch 每请求多一次 GET | 回环 Redis，约 0.1–0.2ms | 若 P95 被它顶到线外：进程内 epoch 副本 + 1 秒刷新（代价：失效延迟 1 秒） |
| TouchAsync 的进程内节流表 | 1 万条上限，超了整表清空 | 不用动（它只是写库频率的节流器，清空只多写几次库） |
| 审计列表不做 action 单列索引 | 管理员动作一年几千行 | audit_logs >100 万行时再补 |
| 全部索引常驻内存 | users/sessions/audit 的热索引合计 < 50MB | shared_buffers=1GB 下无压力 |

---

## 17. 未决问题（每条给两种选择的代价，**不要自己拍**）

> 编号 U1–U21 供 Lead 回写与拍板时引用。凡本设计已按某一方案落地的地方，都在"我的取舍"里写明。

## 17.0 已定案（拍板 §9.9 / §9.12，2026-10-13）——本节是**追溯记录**，逐条写明落到了本文的哪一段

Lead 已在拍板 §9.9（U1–U21 裁决）与 §9.12（最后两条 + 表头更正）里全部拍完，并追加了 §9（注册激活）与 §11（验证码）两节新需求。**本文已按裁决改完**，对应关系如下：

| 拍板条目 | 定案 | 落到本文哪里 |
|---|---|---|
| U1 权限点 23/24 | **24 + resource.publish = 25** | §8.6 常量表、迁移数据、勾选矩阵（3/8/18/25）、§14.2 自检、§18.2 第 16 条 |
| U2 `resource.publish` | **要**（发 `kind='resource'` 时多要一条，service 层判） | §8.6 矩阵下的说明与 forum 的判定顺序 |
| U3 `roles.is_super` | **要**，不许比较 `role.key` | §5.4 + `uq_roles_super` |
| U4 `idx_users_nickname_lower` | **要** | §5.10 索引表 + §11.4 |
| U5 pgsql 子包 | **`internal/auth/pgsql`**（+ `internal/user/pgsql`） | §2 目录树；需回写方案 §3 与 §15.7 |
| U6 未验证能不能登录 | **能**；写闸门只有 `auth.not_activated`；`auth.email_unverified` **作废** | §9.3 整节重写、§15 错误码、§18.4 |
| U7 旧站未激活导入 | 照 §10.2 映射；未激活者用**同一个** `auth.not_activated`，不特判 | §9.3 表格末行 |
| U8 角色层级 | **读时闭包** | §8.2 / §8.3 的 `WITH RECURSIVE chain` |
| U9 `board.moderate` 给 admin | **给** | §8.6 矩阵 |
| U10 导审计本身写审计 | **要写** | §8.10 动作清单新增 `audit.export` 一行 |
| U11 登录防重复提交 | **不做** | §9.5 幂等列的说明 |
| U12 `default_avatar_hash` | **要**（可空列 + 单列 FK 索引） | §5.1 列与索引 + §10.7 |
| U13 会话 `{id}` | **public_id**（sessions 加这一列） | §5.2 + §9.5 |
| U14 管理端用户列表 | **归独立 admin 模块**（不在 D2） | §17 U14（保留，供追溯） |
| U15 `avatar` 形态 | **`/img/<hash>` 完整路径** | §11.2 |
| U16 `status='deleted'` | CHECK 保留、**端点不做** | §5.1 不变量 |
| U17 username/email 交叉占用 | **不交叉判** | §7.2 |
| U18 角色树 `depth` | **写入时算并存** | §5.4 |
| U19 `uq_email_tokens_live` | **要**，谓词 `WHERE consumed_at IS NULL`（**不带 now()**） | §5.3 / §5.10 |
| U20 `/me` 与 media 的边界 | 纯文本字段归 user；**头像归 media**，两模块各写各的列 | §9.3（头像不再被闸门挡）、交接单 §2.3 |
| U21 `GET /me/sessions` 字段 | `id`/`ip`/`user_agent`/`last_seen_at`/`created_at`/`is_current`；**不回 token** | §9.5 + §18.3 第 29 条 |
| 拍板 §12 注册激活一个开关 | **取代 §9 的两条激活路**：删 `activation_pending`、删自动降级；模式 = `site_settings` 的 `auth.registration.auto_activate`（默认 true） | §5.1（列已删）、§10.1（两种模式 + 读开关）、§10.3（503 且注册回滚）、§10.5（false 时不重发）、§15.2、§17.2、§18.4 |

**三条新需求已经改完**：邮箱激活改成 6 位验证码与它的爆破上限（拍板 §11 → §10.2–§10.5）、找回密码改成"验证码 + reset_ticket 两步"（§10.6）、**注册激活简化为一个开关**（拍板 §12 → §10.1；§9.2/§9.3 的 `activation_pending` 与自动降级已删）。

### 17.2 本次设计变更的「四问」（缺陷处理总纲 §4）

拍板 §12 把 §9 的"两条激活路 + 发不出去就降级"换成了一个开关。按缺陷处理总纲 §4 记四问——**这不是"改个设计"，是一次设计缺陷的根因处理**：

| 问 | 答 |
|---|---|
| **现象** | 同一次注册会出现两种完全不同的旅程（"等邮件输码" vs "等管理员点激活"），前后端都要先读一个用户字段才知道该不该发信、该不该给重发按钮；而那个字段的值还取决于"当时发信成不成功"，于是同一个用户的旅途会在重发之后**改道**（manual → email） |
| **根因** | **把一个全局配置当成了每用户状态**。`activation_pending` 想表达的是"发信成功没有"，但"发不发信"从一开始就是**管理员选的一个模式**，不是每个用户各自产生的结果。用用户字段承载配置，就必然要再造一套"从 manual 回 email"的迁移逻辑，并且让"注册走人工"这个**产品选择**与"配置坏了"这个**故障**长得一模一样 |
| **堵法** | ① 删字段（迁移 + ent schema + 本文档三处，见 §5.1）；② 模式由一个 `site_settings` 键决定（§10.1），**读开关时顺带把"要不要发码"判掉**，不需要第二份状态；③ 删掉"发不出去就降级"的分支，改成"没配好就 503 且注册回滚"——**让配置错误在注册那一刻暴露**，而不是静默变成另一种产品行为；④ 验收里加一条"全库不存在 `activation_pending` 列"（拍板 §12.6 第 7 条），让"删干净了没有"可断言；⑤ 前端两种未激活文案由同一开关派生（拍板 §12.5），不引入第三种状态 |
| **是否误操作** | **不是**。这是设计层面的判断错误（字段放错了层），所以按上面五条堵，不按"打错字"处理 |

**仍然需要 Lead 决定的一件（出现了一个新的不一致）**：拍板 §10.8 第 1 条自己记着「P1b 已落库的是 24 个权限点（`topic.pin` 兼管 `/feature`）」，而 §9.9 的 U1/U2 又要求 25 个（含 `topic.feature` 与 `resource.publish`）。两条并存的话 **`topic.feature` 是一个永不生效的勾**（端点判的是 `topic.pin`）。二选一：**A** 补迁移加 `resource.publish` 并把 `/feature` 改成判 `topic.feature`；**B** 常量表退回 24 个（删 `topic.feature`，精华回到 `topic.pin` 兼管）。**在选定之前 §14.1 的启动自检会红，那是它该有的行为。**

### U1 权限点到底 23 还是 24 个

拍板 §1.2 的表头写「全集（23 个）」，但表里我数了三遍是 **24 行**，且 §1.3 让 creator 有 topic.feature。

- ① **取 24**（含 `topic.feature`，本设计）：与 §1.3 的角色定义一致；代价是"23"这个数字出现在旧文档里要一起改。
- ② 取 23（删 `topic.feature`，精华与置顶共用 `topic.pin`）：与表头数字一致；代价是 `/topics/{id}/feature` 与 `/pin` 共用一个权限点，将来想分开"谁能精华、谁能置顶"要再加。

**我的取舍：①**，并请 Lead 把 §1.2 表头改成 24。

### U2 `resource.publish` 在不在

拍板 §1.3 的 creator 说明里有它，§1.2 的 23/24 个里没有。

- ① **不要它**（本设计）：发资源帖 = `topic.create` + `topics.kind='resource'`；代价是无法单独限制"谁能发资源帖"。
- ② 要它（第 25 个权限点）：可以单独限制；代价是 forum 里要写清 `topic.create` 与 `resource.publish` 的判定顺序（两个都要？还是后者替代前者？）。

**我的取舍：①**。若产品确实要"仅认证创作者能发资源帖"，那必须加，并同时定判定顺序。

### U3 `roles.is_super` 这一列要不要

- ① **要**（本设计）：超管短路来自数据，符合方案 §15.23「禁止比较角色字符串」；代价是多一列 + 一条部分唯一索引 + 要保证只有一个角色是 true。
- ② 不要：判定写成 `actor.RoleKey == "superadmin"`；零 schema 成本；代价是**直接违反 §15.23**，而且角色 key 从此不能被改（改了就丢超管）。

**我的取舍：①**。

### U4 `idx_users_nickname_lower` 要不要

- ① **要**（本设计）：`/users/search` 的昵称前缀在中文排序规则下能走索引；代价是多一条索引。
- ② 不要：昵称前缀退化成 Seq Scan，1 万用户下约 3–5ms；代价是随用户数线性增长。

**我的取舍：①**。用户量若确认只有几千，删掉也合理。

### U5 `pgsql` 子包放哪

后端方案 §3 的目录树里没有「业务模块下的 pgsql 子包」，而 §15.7 只允许原生 SQL 出现在 `platform/search/pgsql` 与手写迁移里。

- ① **`internal/auth/pgsql` + `internal/user/pgsql`**（本设计）：SQL 与调用点同模块；代价是偏离目录树，要在 §3 加两行。
- ② 全塞进 `internal/platform/search/pgsql`：字面合规；代价是「权限查询」与「搜索」挤一个包，且 platform 层从此有了业务语义的查询。

**我的取舍：①**，并建议 Lead 在 §3 的目录树补两行、在 §15.7 的措辞里明确"业务模块的 pgsql 子包"。

### U6 未验证用户能不能登录（**最需要拍板的一条**）

方案 §9.1 写「注册必须完成邮箱验证才能登录」；20.2 第 22 条与拍板 §1.5 写「未验证只能读 + 改自己资料，写内容 403」。**后者预设了未验证用户可以登录。**

- ① **按 20.2 第 22 条**（本设计）：未验证可登录；代价是 §9.1 那句话要删，且要维护 §9.3 那张逐端点表。
- ② 按 §9.1：未验证不能登录；代价是 `auth.email_unverified` 变成**永远不可能出现的死代码**，M2 的验收项"未验证用户写操作 403"也无从验证。

**我的取舍：①**。20.2 是后补的缺口清单且给了完整错误码；②会让一个错误码与一条验收项一起失效。

### U7 旧站导入用户的 `activated_at`（未激活能不能写）

数据库文档 §10.2 把旧 `activated_at` 映射到新 `activated_at`，而本设计的 §9.3 只列了 `auth.email_unverified`，没有列"未激活"。

- ① **照 §10.2 做**（本设计）：旧库"未激活"的人导入后能登录、不能写内容；代价是**要为「未激活」补一张逐端点表或一个错误码**（我留了 `actor.Activated` 字段，但没定义"未激活的拒绝码"）。
- ② 导入时 `activated_at = now()` 全放行：简单；代价是丢掉旧站"管理员审核后才能发帖"的语义。

**我的取舍：①**（不改映射），但**必须由 Lead 拍**：旧站未激活用户导入后能不能直接发帖；若能，②的代价是零。

### U8 角色层级：写穿还是读时闭包

- ① **读时闭包**（本设计）：改角色权限只写一行、没有中间态；代价是读路径多一次递归。
- ② 写穿：`role_permissions` 是展开后的并集、读路径一次 JOIN；代价是改父角色要递归写所有后代，**写到一半失败会留下"子角色缺了父角色有的权限"的中间态**。

**我的取舍：①**，且四个内置角色 `parent_id` 全为 NULL，所以内置角色的集合就等于那一行行勾选。将来加自定义角色时 ① 自动成立。

### U9 `board.moderate` 给不给 admin

- ① **给**（本设计，与拍板 §1.3 字面一致）：只有被任命到具体分区才生效；代价是 admin 总能被任命为版主。
- ② 不给：只有 superadmin 能当版主；代价是"管理员兼版主"要改走 `permission.grant` 追加。

**我的取舍：①**。

### U10 `audit.export` 这个动作本身要不要写审计

- ① 写：能回答"谁把全站操作痕迹导走了"；代价是导出动作也进日志。
- ② **不写**（本设计）：靠 nginx 访问日志；代价是应用层看不到。

**我的取舍：②**，但这是安全相关的一条，**我倾向被推翻成 ①**（导出是"能一次导走全站痕迹"的权力，代价只有一行 INSERT）。

### U11 登录要不要防重复提交

- ① **不防**（本设计）：双击登录 = 两个会话，会话列表多一行。
- ② 防：同 IP+账号 500ms 内只建一个会话；代价是多一份状态，而且它会掩盖"用户真的开了两个窗口"这个正常场景。

**我的取舍：①**（前端在提交期间禁用按钮即可）。

### U12 users 要不要 `default_avatar_hash` 列

- ① **不要**（本设计）：无头像时读路径按 `users.id` 对池子大小取模；代价是池子增删时同一个人的默认头像会变。
- ② 要：**分一次就固定**（旧站语义，默认头像池的注释明确写过）；代价是 users 多一列 + 一次"首次分配"的写。

**我的取舍：①**（池子是 D4 的运行时数据）。**若产品在意"默认头像不能变"，就必须 ②**。

### U13 会话列表里的 `{id}` 用什么

- ① **`token_hash` 的 base64url 前 16 字节**（本设计）：不加列；代价是它不是 UUID，前端当不透明串。
- ② 加一列 public_id：与其它资源一致；代价是多一列 + 一次生成。

**我的取舍：①**。

### U14 管理端用户列表与详情归谁

界面施工 §5.8 要 `GET /admin/users`（三个状态轴筛选）与 `GET /admin/users/{id}`（含 sanctions / user_permissions / titles）。

- ① 都放 D2：本域已有权限与角色；代价是 D2 要**跨域读** sanctions（D3 的表）与 titles（title 模块的表）。
- ② 列表给 D2、详情给管理域：代价是两个域都要按 §5.8 拼字段。

本设计**只做设计 §9.5 那批端点**，列表/详情不在其中。**这条要 Lead 拍。**

### U15 `GET /users/{handle}` 里 `avatar` 的形态

- ① **本域返回路径**（本设计）：需要 user 的 deps.go 里加一个 media 的 URL 生成器接口；代价是多一个跨模块接口。
- ② 本域返回 hash、前端自己拼：**违反开发必读 §12「路径只能有一个来源」**，且 `/img/` 的分目录规则一变就两边改。

**我的取舍：①**，接口形状要与 D4 对齐。

### U16 `users.status='deleted'`（注销）要不要做

- ① **只定义状态值、不做端点**（本设计）：`GET /users/{handle}` 对 deleted 返回 404；代价是"注销"功能不存在。
- ② 做注销：要决定删什么（邮箱？昵称？内容？）、能否恢复、保留多久——**这是产品决定**。

**我的取舍：①**（拍板 §6 没列它，旧站也没有）。

### U17 注册时 username 与 email 的交叉占用

`findUserByLoginSQL` 用 `username OR email` 匹配，所以 A 的 username 可以等于 B 的 email（合法但歧义）。

- ① 注册时拒绝交叉占用：多一条 EXISTS；代价是多一个 409 场景。
- ② **不管**（本设计）：歧义只影响"有人故意把 username 设成别人的邮箱"；代价是那种情况下登录结果依赖 id 顺序。

**我的取舍：②**，但**必须在测试里固定住"歧义时按 id 取第一个"**，否则将来有人改了没人知道。

### U18 角色树 `depth` 的维护

- ① **保留**（本设计）：只作展示排序、不加"≤3"上界 CHECK；改父节点时由 service 递归重算子孙 `depth`；代价是一段递归 UPDATE（内置四角色用不到）。
- ② 不要这一列：展示时按 parent_id 现算；代价是每次列角色做一次树遍历（几十行，无所谓）。

**我的取舍：①**（RBAC 文档 §1.2 有它）。选 ② 时要同时删掉 RBAC 文档里的 `depth`。

### U19 `uq_email_tokens_live`（一个 purpose 一条活跃令牌）

- ① **要**（本设计）：重发 = upsert，旧链接立刻失效，且不需要"先删后插"（并发下会留两条）。
- ② 不要：允许多条活跃令牌；代价是旧邮件里的链接仍然有效——改邮箱/被盗号时这是风险。

**我的取舍：①**。

### U20 本域 `/me` 的写入与 media 模块的边界

头像与收款码上传要落文件 + 写 images 表 + 改 `users.avatar_hash`。

- ① **media 提供接口、auth 在同一个 handler 里按顺序调**（本设计）：一次 HTTP 请求、一次事务改 users；代价是 media 要暴露"上传并绑定到当前用户"的接口。
- ② media 自己实现 `POST /me/avatar`：路由归 media；代价是 `users.avatar_hash` 变成两个模块都写，违反 §4.1 的"一个写者"。

**我的取舍：①**，接口形状见交接单 §2。**要与 D4 对齐**（D4 可能已按 ② 设计）。

### U21 `GET /me/sessions` 的响应字段

方案 §21.2 只说"含 ip、user_agent、last_seen_at、是否当前"。

- ① **六个字段**（本设计）：`id / ip / user_agent / created_at / last_seen_at / current`；代价是用户看不到"还有多久掉线"。
- ② 再加 `expires_at`：多一个字段，零成本。

**我的取舍：①**，若界面要显示有效期就加。**需前端确认。**

---

### U22（**已定案 2026-10-13**）`auto_activate=false` 时 `POST /auth/email/resend` 返回什么

- ① **503 `auth.mail_unavailable`**（本设计）：用户可见的事实是同一句"现在发不出验证码"；前端在那种模式下本来就不显示重发按钮（拍板 §12.5），所以这个码只服务"后端不信任前端"的那一半。代价是语义略宽——它同时表示"没配账号"与"这个模式没有码"。
- ② 新造一个码（例如 `auth.resend_unavailable`）：语义更准；代价是多一个码、多一处要用对的地方，而主路径根本不经过它。

**定案：两个都不选，选第三种——403 + 新码 `auth.activation_is_manual`**（文案「本站当前采用管理员激活，不需要验证码」）。Lead 的三条理由：

1. **403 正确**：不是服务故障，是**策略决定**，客户端不该重试；
2. **新码值得**：它精确说出"为什么"不能重发（本模式没有码），而 `auth.mail_unavailable` 表达的是"发信系统出问题"——**两件不同的事不该共用一个码**；
3. 它把**配置错误**与**产品选择**分开了：`true` + 没配账号 → 503 `auth.mail_unavailable`（该去修）；`false` → 403 `auth.activation_is_manual`（无需修）。

我原来选的 ① 是错的：503 会让前端与运维以为"等会儿就好"，而这个站**按配置就是不发邮件**，重试一万次也一样。已落到 §10.5、§15.2 与 §9.5 的路由表。

---

## 18. 测试清单（每条写清断言什么）

> 铁律：**没有测试的"必须"等于没有"必须"**（复盘根因 11）。下面每条都能在 CI 里跑红。
> 集成测试一律真 PG + 独立 schema（拍板 §5.8），固定时钟用 clock.Fake。

### 18.1 argon2id 与信号量（`password_test.go`）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 哈希新密码 | PHC 串前缀 `$argon2id$v=19$m=32768,t=2,p=2$`，salt 16 字节、hash 32 字节 |
| 2 | 同一密码两次哈希 | 两个串不同（salt 随机） |
| 3 | 校验正确/错误密码 | 前者 nil，后者 err |
| 4 | 占位哈希 `"!"` | 校验恒失败，**不 panic** |
| 5 | `needsRehash` | m=19456 → true；m=32768,t=2,p=2 → false；非法串 → false |
| 6 | **旧串登录后升级** | 用 m=19456 的真实旧串建用户 → 登录成功 → 库里串变成 m=32768 → **同一明文仍能校验通过** |
| 7 | 信号量：并发 2 个占满 | 第 3 个请求 3 秒内返回 503 `auth.hash_busy`，且日志有一条 Warn |
| 8 | 信号量：释放后可进 | 前两个释放后第三个立即成功（不等满 3 秒） |
| 9 | 信号量：ctx 取消 | 返回 `context.Canceled`，不是 503 |

### 18.2 authz 纯逻辑（`set_test.go` / `actor_test.go`）

| # | 用例 | 断言 |
|---|---|---|
| 10 | `Set` 基本操作 | Add/Has/HasAll/Any 的边界（空集合、重复加入） |
| 11 | `Require(actor, perm)` | 有权限 nil；无权限 `common.forbidden` |
| 12 | **超管短路** | `IsSuper=true` + 空 Perms → `Require` 通过；**且 Perms 里确实没有那个权限点**（证明走的是短路而不是集合） |
| 13 | `Status='banned'` | 即使 `IsSuper=true` 也返回 401（封号一票否决） |
| 14 | `actor == nil` | 401 |
| 15 | `CanInBoard` | BoardIDs 命中 true、不命中 false、IsSuper 恒 true |
| 16 | **权限点常量集合** | `len(authz.All())` == 25，且与 §8.6 的表逐字相同（把表写成代码里的切片做对照） |

### 18.3 会话生命周期（`service_test.go`）

| # | 用例 | 断言 |
|---|---|---|
| 17 | 无 Cookie 访问公开页 | 200，`FromGin` 返回 false |
| 18 | 伪造/过期 token | 200（当游客）+ 响应里有清 Cookie 的 `Set-Cookie`；**库里没有任何行被改** |
| 19 | 正常登录 | Cookie 有 HttpOnly/SameSite=Lax/Path=/；`GET /me` 的 UserID/Perms 正确 |
| 20 | 库里只存摘要 | `SELECT token_hash FROM sessions` 的值 ≠ Cookie 的值，且长度 32 |
| 21 | **封号后立刻请求** | 封号 → **同一 cookie 的下一个请求**写接口 401（**不等 60 秒**） |
| 22 | 改密码后用旧 Cookie | 立刻 401（该用户全部 session 被删） |
| 23 | **1000 次请求的 touch** | 累计被刷新的行数 == 1；`expires_at` 一次未改 |
| 24 | touch 的 24 小时续期 | clock 前进 25 小时后一次请求 → 续期 SQL 命中 1 行，`expires_at` 变成 now+720h |
| 24b | 封号后清缓存 | `BanUser` 之后再发一次请求：缓存条目里的 status 已是 banned → 401（**不等 TTL**） |
| 25 | **权限缓存 60 秒** | 第二次请求不查库（用计数包装或 pg_stat 观测）；TTL 过后再查一次 |
| 26 | 缓存条目内容 | 解 JSON：同时含 status、board_ids、perms、is_super（**盲审 B1 的要求**） |
| 27 | 后台改权限后立刻失效 | 追加权限 → **下一个请求** Perms 里就有了 |
| 28 | 任免版主后立刻失效 | 写 board_moderators + InvalidateUser → 下一个请求 BoardIDs 有了（这条同时是 D3 契约的守卫） |
| 29 | 会话列表 | 只返回自己的会话，`current` 标记正确，`{id}` 可用来踢它 |
| 30 | 踢别人的会话 | 用 A 的 cookie 删 B 的会话 → 404，B 的会话还在 |

### 18.4 注册 / 登录 / 令牌端点

| # | 用例 | 断言 |
|---|---|---|
| 31 | 注册成功 | 201、`GET /me` 返回 `data:null`（**不自动登录**）、有一行 email_tokens(purpose=verify) |
| 32 | 大小写重名 | 先注册 `TangTian`，再注册 `tangtian` → **409 `auth.handle_taken`**（同时证明 `lower()` 唯一索引真的生效） |
| 33 | 邮箱大小写重复 | 同上，`auth.email_taken` |
| 34 | 密码规则 | 7 字节 → 400；全空白 → 400；129 字节 → 400 |
| 35 | 登录失败不区分原因 | 不存在的用户与错误密码返回**同一个 code**，且都记一次限流 |
| 36 | 登录限流 | 第 6 次（同账号）→ 429 且带 Retry-After |
| 37 | 明文口令不进日志 | 捕获 slog 输出，断言不含密码 |
| 38 | **未激活可登录**（拍板 §9.12） | 新注册用户 `GET /me` 返回数据、`activated=false`；发帖 403 `auth.not_activated`；**读帖子 200** |
| 39 | 验证码正确 | 200 → `email_verified_at` 与 `activated_at` 都非空、该码 `consumed_at` 非空；**第二次同一码 → 400** |
| 40 | 验证码错 5 次 | 前 4 次都 400 且 `attempt_count` 递增；**第 5 次后该码 `consumed_at` 非空**；第 6 次即使输对也 400（拍板 §11.8 第 3 条） |
| 41 | 验证码过期与统一文案 | clock 前进 11 分钟 → 400，且**响应体与"码错"逐字节相同**（除 request_id） |
| 42 | 重发作废旧码 | 重发 → 旧码 400、新码 200；`email_tokens` 里只有一行 `consumed_at IS NULL`；`attempt_count` 归零（拍板 §11.8 第 4 条） |
| 43 | 按账号限流 | 15 分钟内累计 10 次失败 → 429 `auth.too_many_requests` + Retry-After；**成功一次后计数清零** |
| 44 | **开关 true + 没配发信账号**（拍板 §12.6 第 2 条） | 清空 mail_accounts → 注册 → **503 `auth.mail_unavailable`**，且**账号没有建**（`users` 里查不到）、`jobs` 里没有邮件任务。**不是**"201 + 默默等人激活" |
| 45 | **开关 false**（拍板 §12.6 第 3 条） | 注册 → 201、**不发任何邮件**、`email_verified_at` 与 `activated_at` **都是 NULL**；注册响应里**没有任何"模式"字段** |
| 46 | **开关 false 时的重发** | `POST /auth/email/resend` → **403 `auth.activation_is_manual`**（**不是** 503，见 §17 U22 定案），且**用户的任何列都没被改** |
| 46a | **两个码各归各位** | 同一次跑里断言两种情形不同码：`false` → 403 `auth.activation_is_manual`；`true` 且清空 mail_accounts → 503 `auth.mail_unavailable` |
| 46b | **管理员激活**（拍板 §12.6 第 4 条） | `auto_activate=false` 的用户被后台「激活」→ `activated_at` 非空、`email_verified_at` **仍为 NULL**；此后发帖 200 |
| 46c | **开关切换立刻生效**（拍板 §12.6 第 6 条） | 开关 true→false → **≤30 秒内**下一次注册就不发码（clock.Fake 前进 31 秒断言；同时断言 30 秒内仍走旧值） |
| 46d | **全库没有那一列**（拍板 §12.6 第 7 条） | 迁移跑完后查 `information_schema.columns`，断言 `users` 上没有 `activation_pending` |
| 47 | 找回密码不暴露邮箱 | 存在与不存在的邮箱都 200，且响应体除 request_id 外相同 |
| 48 | reset 两步 | verify-code → 拿 ticket（**码没有被消费**，还能再用一次）→ reset { ticket, new_password } → 旧密码登录失败、新密码成功、**全部会话被删** |
| 49 | ticket 一次性 | 第二次带同一 ticket → 400；ticket 过期（clock +11 分钟）→ 400 |
| 50 | 改密码 | 200 → 同 cookie `GET /me` 得到 `data:null`；旧密码登录 401、新密码 200 |
| 51 | 改密码成同一个 | 400，fields 指向 new_password |

### 18.5 RBAC 数据与提权（`privileges_test.go`）

| # | 用例 | 断言 |
|---|---|---|
| 47 | 迁移数据 | 4 个角色存在；权限数 3/8/18/25；`permissions` 表 25 行且 key 集合 == 常量集合 |
| 48 | `is_super` 唯一 | 插第二个 `is_super` 角色 → 唯一索引冲突 |
| 49 | 改角色矩阵 | 加一条 → 该角色的用户**下一个请求**就有了 |
| 50 | 内置角色不可删 | 删 `user` → 409 `admin.role_system` |
| 51 | 在用角色不可删 | 自定义角色有用户 → 删 → 409 `admin.role_in_use`（FK RESTRICT 也兜） |
| 52 | 追加权限必带 reason | 空 reason → 400（DB 的 `ck_user_permissions_reason` 也兜一次） |
| 53 | 追加权限带过期 | `expires_at` 在过去 → 400；未过期的追加出现在 `Perms` 里，过期后消失（clock.Fake） |
| 54 | 回收权限 | DELETE → 下一个请求 `Perms` 里没了；再 DELETE → 404 |
| 55 | **最后一个超管不可降权** | 唯一激活超管降权 → 409 `admin.last_super`；**库里 role_id 未变** |
| 56 | 第二个超管出现后可降权 | 建第二个激活超管 → 第一个能降权 |
| 57 | **被封的超管不算数** | 两个超管、封掉一个 → 降另一个 → 409 |
| 58 | **最后一个超管不可封** | 封唯一激活超管 → 409 `admin.last_super` |
| 59 | 普通用户调管理端点 | 403 `common.forbidden`（不是 404） |
| 60 | 未登录调管理端点 | 401 |
| 61 | 自定义角色只勾一个权限 | 该角色用户只能做那一件事（其余 403）——方案 §17 M2 的验收项 |
| 62 | 未验证邮箱的 admin 改角色 | 403 `auth.email_unverified`（**先验证后提权**，防"假邮箱换管理员"） |
| 63 | admin 不能给自己提权 | admin 调 `PATCH /admin/users/{自己}/role {superadmin}` → 403（他连 `role.assign` 都没有） |
| 64 | 改角色写审计 | `audit_logs` 有一行 action=`user.role.assign`、detail 含 before/after |
| 65 | 封号写审计 + 返回会话数 | 响应的 `sessions_revoked` == 该用户会话数；审计 `user.ban` |
| 66 | **审计与业务同事务** | 在 `WriteAudit` 里注入一个必然失败的写（如审计表制造冲突）→ **业务改动也回滚**，用户状态未变 |

### 18.6 user 模块

| # | 用例 | 断言 |
|---|---|---|
| 67 | 大小写 handle | `GET /users/TangTian` 与 `/users/tangtian` 返回同一人 |
| 68 | 不存在 | 404 `common.not_found` |
| 69 | 封禁用户 | 200 + `status:'banned'`（**不是 404**） |
| 70 | 注销用户 | 404（status='deleted'） |
| 71 | exp_max | exp=1200 → level 3、exp_max 1600 |
| 72 | `topic_count` | 只算 `visibility='normal'` 且 `review_state='approved'` 的主题（插一条 pending 的不许算进去） |
| 73 | `like_received` | 只算该用户 `status='normal'` 的帖子收到的赞（插一条已删帖的赞，不许算进去） |
| 74 | 搜索重名 | 两个同昵称用户 → 结果里两行 `ambiguous=true` |
| 75 | 搜索前缀 | `q=唐` 命中昵称、`q=t` 命中 username（两条不同路径都要测） |
| 76 | 搜索 limit | limit=999 → 只返回 20 |
| 77 | 搜索排除封禁 | 封禁用户不出现在结果里 |

### 18.7 自检与不变量（能红的证明）

| # | 用例 | 断言 |
|---|---|---|
| 78 | 权限点自检 | 从 `permissions` 删一行 → `CheckPermissions` 返回 error 并含该 key |
| 79 | 权限点反向 | 往 `permissions` 插一行代码里没有的 → 只 Warn（函数返回 nil + 一条 Warn 日志） |
| 80 | **枚举自检能红** | 把 `users.status` 的 CHECK 改成 4 个值 → `CheckEnums` 返回 error |
| 81 | **枚举解析夹具** | 直接喂一条带双引号的 `pg_get_constraintdef` 文本给 `quotedLiterals`，断言解析出正确集合（防"静默比不过"） |
| 82 | **外键索引负例** | 建表 + 无索引外键 → 检查 SQL 返回 ≥1 行；加上索引 → 0 行。**空库跑通不算数** |
| 83 | 等级不变量 | 手写 `UPDATE users SET level = 99` → 自检返回该用户；改回 → 0 行。另测 9 个 exp 边界点（§12） |
| 84 | 角色权限数自检 | 改掉一个勾选 → Warn 出现且数字是 3/7/17/24 里对应的那个 |

### 18.8 EXPLAIN 索引验收

| # | 用例 | 断言 |
|---|---|---|
| 85 | `lower(username)` 走索引 | `EXPLAIN` 文本含 `uq_users_username_lower` |
| 86 | 反例（证明 85 有效） | 把查询改成 `WHERE username = $1` → 断言出现 `Seq Scan`（**这条让 85 不会因为"表太小所以走索引"而假绿**） |
| 87 | 昵称前缀走索引 | `lower(nickname) LIKE 'ab%'` → 含 `idx_users_nickname_lower` |
| 88 | 会话解析 | 含 `uq_sessions_token`，4 条 Index Scan |
| 89 | 权限闭包 | 含 `role_permissions_pkey` 与 `idx_user_permissions_user` |
| 90 | 审计列表三种筛选 | 分别走 `_dump` / `_actor` / `_target` |

**数据量**：85/87/88/89 在**只有几行**的 schema 上跑会得到 Seq Scan（PG 对空表一律顺扫）。所以这组测试要先灌入**至少 1000 个用户 + 5000 个会话 + 2000 条审计**；或者断言"索引名出现在计划里"而不是"没有 Seq Scan"。两种写法二选一，但 **86 的反例必须在同一夹具下也是红的**，否则整组测试没有意义。

### 18.9 迁移与拍板对齐（本轮新增，必须能红）

| # | 用例 | 断言 |
|---|---|---|
| 91 | 权限点与迁移一致 | 跑完 `0008_seed_rbac.sql` 后 `CheckPermissions` **返回 nil**；`permissions` 表 25 行；四个角色 3/8/18/25（**P1b 若还是 24 个的版本，这条必须红——那是它该有的行为**） |
| 92 | `resource.publish` 真的生效 | creator 发 `kind='discussion'` → 200；发 `kind='resource'` → 200；**user 发 `kind='resource'` → 403 forum...**（forum 的判定，本域只保证 `Perms` 里有这个点） |
| 93 | 拍板索引谓词 | 迁移能建出 `uq_email_tokens_live ... WHERE consumed_at IS NULL`（**任何谓词里带 `now()` 的写法都必须建表失败**——这条用一条反例 SQL 证明） |
| 94 | 三根轴互不干扰 | 手动激活（email_verified_at 仍 NULL）的用户能发帖；邮箱已验证但未激活的用户不能发帖（两个方向都要断言） |

### 18.10 单元测试之外的 CI 门禁

    gofmt -l .            # 无输出
    go vet ./...
    golangci-lint run     # 方案 §14.10 的那批 linter
    go test ./...         # 上面 90 条
    # 迁移测试：空库 → 全部迁移 → 复跑一次（幂等）→ 基本读写
    # 自检测试：迁移后跑 §14.1–14.4，全部零结果 / 零失败
