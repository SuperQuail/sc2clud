# D2 交接单（auth / authz / user）—— 对外接口、依赖、未决问题

> 配套文档：`完全重构/后端设计/d2-auth.md`（设计本体）。本文件只列**接口签名与依赖**，实现细节看设计文档对应章节。
> 本域**没有写一行 Go 代码、没有改 go.mod、没有生成 ent 代码**（本轮交付 = 设计）。

---

## 1. 本域对外暴露的 Go 接口

### 1.1 `internal/authz`（纯函数库，无依赖）

```go
type Set map[string]struct{}

func NewSet(keys ...string) Set
func (s Set) Has(perm string) bool
func (s Set) HasAll(perms ...string) bool
func (s Set) Any(perms ...string) bool
func (s Set) Keys() []string                       // 排序后的副本，给 /me 与审计用

type Actor struct {
    UserID        int64
    PublicID      string
    Perms         Set
    BoardIDs      []int64
    RoleID        int64
    RoleKey       string
    RoleName      string
    RoleBadge     string
    IsSuper       bool
    EmailVerified bool
    Activated     bool
    Status        string
}

func Require(a *Actor, perm string) error          // 危险写操作的 service 层兜底（队列/cron/CLI 只靠它）
func HasAny(a *Actor, perms ...string) bool        // PermAny 中间件用
func CanInBoard(a *Actor, boardID int64) bool      // 分区作用域判定（forum 调）

// 权限点常量 + 目录
func All() []string                                // 24 个 key，排序
type PermMeta struct{ Key, Group, Name, Description string }
func Catalog() []PermMeta                          // 后台勾选界面用（grp 分组 + 中文名）
```

**它不碰数据库、不碰 gin**。任何模块都能 import，不会形成环。

### 1.2 `internal/auth` Service（本域内部用；`deps.go` 的小接口是别的模块用的）

```go
type Service struct{ /* cfg, db, dbRead, kv, limiter, queue, clock, log, hasher, touch */ }

func NewService(cfg config.Auth, db, dbRead *ent.Client, kv KV, limiter Limiter,
                q Queue, clk clock.Clock, log *slog.Logger, users UserLookup) *Service

// —— 会话 ——
func (s *Service) Resolve(ctx context.Context, rawToken string) (*Principal, error)
func (s *Service) ClearCookie(c *gin.Context)
func (s *Service) TouchAsync(digest string)

// —— 失效（跨模块契约，见 §3）——
func (s *Service) InvalidateUser(ctx context.Context, userID int64) error      // epoch +1
func (s *Service) InvalidateSession(ctx context.Context, digest string) error

// —— 中间件 ——
func (s *Service) LoadPrincipal() gin.HandlerFunc
func (s *Service) RequireLogin() gin.HandlerFunc
func (s *Service) RequireVerified() gin.HandlerFunc                 // 登录 + EmailVerified
func (s *Service) Perm(perms ...string) gin.HandlerFunc             // AND + 超管短路
func (s *Service) PermAny(perms ...string) gin.HandlerFunc

// —— 账号与会话（handler 调）——
func (s *Service) Register(ctx context.Context, in RegisterInput) (*RegisterResult, error)
func (s *Service) Login(ctx context.Context, in LoginInput) (*LoginResult, error)
func (s *Service) Logout(ctx context.Context, actor *authz.Actor) error
func (s *Service) Me(ctx context.Context, actor *authz.Actor) (*MeResult, error)          // actor 可为 nil
func (s *Service) UpdateProfile(ctx context.Context, actor *authz.Actor, in UpdateProfileInput) error
func (s *Service) ChangePassword(ctx context.Context, actor *authz.Actor, in ChangePasswordInput) error
func (s *Service) ListSessions(ctx context.Context, actor *authz.Actor) ([]SessionItem, error)
func (s *Service) RevokeSession(ctx context.Context, actor *authz.Actor, sessionKey string) error
func (s *Service) ResendVerify(ctx context.Context, actor *authz.Actor) error
func (s *Service) VerifyEmail(ctx context.Context, token string, ip netip.Addr) error
func (s *Service) ForgotPassword(ctx context.Context, email string, ip netip.Addr) error   // 恒 nil
func (s *Service) ResetPassword(ctx context.Context, in ResetPasswordInput) error

// —— 提权与审计（handler / CLI 调）——
func (s *Service) ListRoles(ctx context.Context, actor *authz.Actor) ([]RoleItem, error)
func (s *Service) ListPermissions(ctx context.Context, actor *authz.Actor) ([]PermItem, error)
func (s *Service) ReplaceRolePermissions(ctx context.Context, actor *authz.Actor, in ReplaceRolePermsInput) error
func (s *Service) SetUserRole(ctx context.Context, actor *authz.Actor, in SetUserRoleInput) error
func (s *Service) GrantPermission(ctx context.Context, actor *authz.Actor, in GrantPermInput) error
func (s *Service) RevokePermission(ctx context.Context, actor *authz.Actor, permKey string, ip netip.Addr) error
func (s *Service) BanUser(ctx context.Context, actor *authz.Actor, in BanInput) (*BanResult, error)
func (s *Service) RevokeUserSessions(ctx context.Context, actor *authz.Actor, userPublicID string, ip netip.Addr) (*RevokeResult, error)
func (s *Service) ListAuditLogs(ctx context.Context, actor *authz.Actor, in AuditQuery) ([]AuditItem, string, error)
func (s *Service) ExportAuditCSV(ctx context.Context, actor *authz.Actor, in AuditQuery, w io.Writer) error

// —— cron（D1 注册）——
func (s *Service) PruneExpiredGrants(ctx context.Context, before time.Time) (int, error)
func (s *Service) PruneSessions(ctx context.Context, idle time.Time) (int, error)
func (s *Service) PruneEmailTokens(ctx context.Context, before time.Time) (int, error)

// —— 启动自检（app 层在开始监听之前调）——
func (s *Service) CheckPermissions(ctx context.Context) error
func (s *Service) CheckEnums(ctx context.Context) error
func (s *Service) CheckRoleSeeds(ctx context.Context) error    // Warn 级，返回统计
func CheckForeignKeys(ctx context.Context, db *sql.DB) error   // forum check 用

// —— CLI ——
func (s *Service) CreateAdmin(ctx context.Context, in CreateAdminInput) error
```

**输入结构体**（都在 `dto.go`/`input.go`，本域定义；**别的模块不需要它们**）：

```go
type RegisterInput struct{ Username, Email, Password, Nickname, CaptchaID, CaptchaAnswer string; IP netip.Addr }
type LoginInput    struct{ Login, Password, CaptchaID, CaptchaAnswer string; IP netip.Addr; UserAgent string }
type MeResult      struct{ /* §9.1 Principal 的公开投影 + extra */ }
type ReplaceRolePermsInput struct{ RoleID int64; PermKeys []string; IP netip.Addr }
type SetUserRoleInput      struct{ UserPublicID string; RoleID int64; IP netip.Addr }
type GrantPermInput        struct{ UserPublicID, PermKey, Reason string; ExpiresAt *time.Time; IP netip.Addr }
type BanInput              struct{ UserPublicID, Action string /* ban|unban */; Reason string; IP netip.Addr }
type AuditQuery            struct{ TargetType, TargetID, Action, ActorPublicID string; From, To *time.Time; Limit int; Cursor string }
type CreateAdminInput      struct{ Handle, Email, Nickname, Password string }
```

### 1.3 Handler 路由注册

```go
func NewHandler(svc *Service) *Handler
func (h *Handler) Register(rg *gin.RouterGroup, authSvc *Service)   // 完整路由表见设计 §9.2
```

### 1.4 `internal/user`

```go
func NewService(cfg config.User, db, dbRead *ent.Client, avatars AvatarURL, clk clock.Clock) *Service

func (s *Service) GetProfile(ctx context.Context, handle string) (*Profile, error)
func (s *Service) Search(ctx context.Context, q string, limit int) ([]SearchItem, error)

// 实现 auth.deps.UserLookup（app 层把 *user.Service 传给 auth）
func (s *Service) GetAuthRow(ctx context.Context, login string) (*auth.UserAuthRow, error)
func (s *Service) GetBasic(ctx context.Context, userID int64) (auth.UserBasic, error)
```

**`AvatarURL`**（user 的 deps.go 定义，由 media 实现）：

```go
type AvatarURL interface {
    // hash 为空时返回默认头像路径（按 userID 取模）；返回的路径已含 /img 前缀，前端直接用
    Avatar(ctx context.Context, userID int64, hash, smallHash string) (avatar, avatarSmall string)
}
```

---

## 2. 我需要别人提供的东西

### 2.1 D1（平台层与组装层）

| 能力 | 形状 | 备注 |
|---|---|---|
| 事务 | `db.WithTx(ctx, c, fn)` | 本域所有多表写都用它 |
| 缓存 | `kv.Cache`，需要 `GetInt64 / Incr(key, ttl) / Get / Set / Del` | 只要这五个方法；epoch 用 `Incr`，条目用 `Get/Set` |
| 限流 | `ratelimit.RateLimiter`：`Allow(ctx, key, limit, window) (bool, time.Duration, error)` | 本域的 key 见设计 §9.5 |
| 队列 | `queue.Queue.Enqueue`（事务外）与 `EnqueueTx`（事务内） | 邮件任务类型常量放 `platform/queue/types.go`，payload `{"id":<userID>}` |
| 邮件 | 只需要「入队」这一条：`mail:send` 任务 + 模板 id `verify_email` / `reset_password` | **业务代码不许直接发信**（方案 §15.10） |
| 自检的例外说明 | `user_permissions` **故意没有指向 users 的外键**（提权记录不能因为删用户而消失），所以 §14.3 的全库外键索引自检不会要求它建索引——这不是漏 | 见设计 §5.7 |
| 时钟 | `clock.Clock`；`clock.Fake` 必须能冻结时间 | 会话过期、令牌过期、touch 节流全靠它 |
| 错误 | `apperr.Error{Code,Status,Msg,Fields}` + `Invalid(fields)` | 本域新增的 11 个码见设计 §15.2 |
| HTTP | `httpx.Bind / OK / Created / Fail`；`httpx.Fail` 负责 500 + request_id | **我要一个例外**：审计导出的 handler 自己写 `c.Writer`（CSV 流式） |
| ID | `idgen.NewPublicID()`（UUID v7）、`idgen.RandomToken(n)`（32 字节 base64url） | DB 不设默认值 |
| 日志 | `*slog.Logger` | — |
| 配置 | `server.cookie_name`、`auth.*`（设计 §4.3）、`user.*` | 需要 D1 把 Auth/User 结构体与 `Validate()` 补上 |
| ent 客户端 | `*ent.Client`（写）与 `*ent.Client`（只读） | 本域的查询用同一个 client 即可（没有跨库） |
| **一个请求** | `platform/idgen` 里加 `parsePublicID(string) (int64, error)` 共用 helper | 拍板 §5.6：不要每个 service 各写一遍 |
| **一个请求** | 启动自检的注册点 | `forum run` 里按顺序调 `CheckPermissions → CheckEnums → CheckRoleSeeds` |

**schema 归属**：本域的 8 个 ent schema 文件由 D2 写（`internal/ent/schema/{user,session,emailtoken,role,permission,rolepermission,userpermission,auditlog}.go`）。**请 D1 先把 `mixin/time.go` 建好**（created_at/updated_at），本域 8 个 schema 都嵌它；另外 `internal/ent/schema` 的 `generate.go` 需要包含 `sql/lock` 特性（方案与数据库文档都要求 `FOR UPDATE`）。

### 2.2 D3（论坛核心）

| 我要什么 | 用途 |
|---|---|
| `board_moderators` 表的读写归你 | 我在 `Resolve`/`loadActor` 里 **JOIN 读**它（SELECT only，不写） |
| **你写 board_moderators 后必须调 `authSvc.InvalidateUser(ctx, userID)`** | 否则版主上任/卸任要等 60 秒才生效（这是本域唯一强制的跨模块回调） |

我需要你确认的列（我按这个写 JOIN）：`board_id, user_id, granted_by, granted_at, expires_at`，主键 `(board_id, user_id)`，**并且 `user_id` 上有一条单列索引**（复合主键的第二列不算已索引，拍板 §5.9 第 6 条；各种删除路径都要扫它）。
另外，拍板 §1.5 的 D6 六步里第 1 步「超管放行」请直接调 `actor.IsSuper`，第 4 步用**该用户基线角色那一行**（不是"任一角色"）。

### 2.3 D4（媒体）

| 我要什么 | 用途 |
|---|---|
| 实现 `user.AvatarURL` 接口 | `GET /users/{handle}` 要返回 `/img/...` 路径而不是 hash（开发必读 §12：路径只能有一个来源） |
| 决定头像/收款码上传端点的归属 | 见设计 U20：我倾向「media 提供接口、auth 的 handler 里按顺序调，`users.avatar_hash` 只有 auth 写」 |
| 默认头像池的分配规则 | 我按「读时取模」设计（U12）；若产品要「分一次就固定」，需要 users 加一列，请告诉我 |

### 2.4 D5（搜索）

| 我要什么 | 用途 |
|---|---|
| `GET /search?type=users` 覆盖用户搜索 | 我只做**前缀**候选（@ 提及），模糊/全文归你；两条路的结果语义要写清，别让用户在两个地方搜到不同的东西 |

### 2.5 运维 / 部署

| 我要什么 | 用途 |
|---|---|
| `forum create-admin` 进部署脚本（S2 之后、上线之前） | 全站必须有至少一个 superadmin，否则没人能进后台。**它不受"最后一个超管"守卫限制**（只增不减） |
| 迁移执行顺序 | `0001_extensions → 0004_roles_permissions → 0005_users → 0006_account → 0007_authorization → 0008_seed_rbac`（设计 §5.10）；users 依赖 images 与 titles 两张表先存在 |
| `forum check` 加入外键索引自检 | 它扫全库，D3/D4 漏索引也会在这里红——**报错必须打印表名** |

---

## 3. 别人可以调我的什么（按模块列，避免重复实现）

| 调用者 | 调什么 | 什么语义 |
|---|---|---|
| 所有模块 | `authz.Require(actor, perm)` | service 层兜底（队列/cron/CLI 必经） |
| 所有模块 | `authz.CanInBoard(actor, boardID)` | 分区作用域（版主）判定 |
| 所有模块 | `auth.FromGin(c)` → `*authz.Actor` | handler 里唯一取身份的方式（禁用 `ctx.Value`） |
| 所有模块 | `authz.Perm*` 中间件 | 路由层声明 |
| 所有模块 | `authSvc.AuditWriter()` 返回的 `audit.Writer` | **写审计的唯一入口**（保证 action 命名与 detail 形状一致）：`Write(ctx, tx, AuditEntry{ActorID, Action, TargetType, TargetID, Detail, IP})` |
| D3 | `authSvc.InvalidateUser(ctx, userID)` | 任免版主后调（§2.2） |
| D3 | `actor.BoardIDs` | 若你想自己判作用域而不调 `CanInBoard` |
| D5 | `actor.Perms` | 搜索结果的可见性过滤（pending/hidden 的帖子） |
| 全部 | `actor.EmailVerified` / `actor.Activated` | 写内容的准入（本域只给字段，判定在各自的 service） |

**不要再实现一遍的东西**：密码哈希与校验、令牌生成与哈希、会话解析、权限集合计算、审计写入、`lower(col)=lower($1)` 的查询写法。

---

## 4. 已知的短暂不可用（不要照抄成本域端点）

| 端点 | 归属 | 说明 |
|---|---|---|
| `GET /admin/users`、`GET /admin/users/{id}` | **未定** | 见设计 U14；我按"不在 D2"设计（它会跨域读 sanctions / titles） |
| `POST /admin/users/{id}/sanctions`（分区禁言） | D3 | `sanctions` 表在论坛域；权限点 `user.mute` 在本域的常量表里 |
| `GET/PATCH /admin/site-settings`、`/admin/diagnostics` | D1 | `site.setting` 权限点在本域的常量表里 |
| `GET/PATCH /admin/mail/*` | 邮件域 | `mail.manage` 同上 |
| `PATCH /admin/users/{id}/role` 的**界面** | 前端 | 端点在本域（§9.5） |

---

## 5. 待办 / 交接检查单

- [ ] Lead 拍 U1–U21（设计 §17）；其中 **U6（未验证能不能登录）与 U1（23 还是 24 个权限点）必须先拍**——它们直接决定迁移数据；
- [ ] Lead 回写：方案 §3 目录树补 `internal/auth/pgsql`、`internal/user/pgsql`（U5）；
- [ ] Lead 回写：方案 §21.4 错误码总表补设计 §15.2 的 11 个码；
- [ ] Lead 回写：拍板 §1.2 表头「23 个」→ 24（U1）；
- [ ] D1 确认 `mixin/time.go`、`generate.go` 的 `sql/lock`、`idgen.parsePublicID`、`auth.*`/`user.*` 配置项；
- [ ] D3 确认 `board_moderators` 的列与 `user_id` 单列索引 + 回调 `InvalidateUser`；
- [ ] D4 确认头像/收款码端点的归属与 `user.AvatarURL` 接口（U20）；
- [ ] 前端确认 `GET /me/sessions` 的字段集（U21）与 `GET /me` 的 `extra` 形状（设计 §8.6 的 `extra[]`）。

---

## 6. 未决问题（完整列表见 `d2-auth.md` §17）

| 编号 | 一句话 | 谁拍 |
|---|---|---|
| U1 | 权限点 23 还是 24（`topic.feature` 在不在） | Lead（影响迁移） |
| U2 | `resource.publish` 要不要 | Lead（产品） |
| U3 | `roles.is_super` 列 | Lead（我建议要） |
| U4 | `idx_users_nickname_lower` | Lead（量级问题） |
| U5 | `pgsql` 子包的位置与文档同步 | Lead |
| **U6** | **未验证用户能不能登录**（方案 §9.1 vs 20.2 第 22 条） | **Lead（必须先拍）** |
| U7 | 旧站未激活用户导入后能不能发帖 | Lead + D1/迁移 |
| U8 | 角色层级：读时闭包 vs 写穿 | Lead（我建议读时闭包） |
| U9 | `board.moderate` 给不给 admin | Lead |
| U10 | 导审计要不要写审计 | Lead（安全） |
| U11 | 登录要不要防重复提交 | Lead |
| U12 | `default_avatar_hash` 列要不要 | Lead + D4 |
| U13 | 会话 `{id}` 用摘要前缀 | Lead |
| U14 | `GET /admin/users` 与 `{id}` 的归属 | Lead |
| U15 | `avatar` 返回路径还是 hash | D4 |
| U16 | 注销（status='deleted'）做不做 | Lead（产品） |
| U17 | username 与 email 的交叉占用 | Lead（我建议不拦 + 测试固定语义） |
| U18 | roles.depth 保留还是现算 | Lead |
| U19 | `uq_email_tokens_live` | Lead（我建议要） |
| U20 | 头像上传端点的模块归属 | Lead + D4 |
| U21 | `GET /me/sessions` 字段集 | 前端 |

**我认为最可能被推翻的一处**：**§6.3/§8.3 的「权限集合由会话缓存承载 + epoch 版本号失效」**。它把「会话认证」与「权限判定」的缓存合成一个条目，是本设计里最大的一次架构取舍（换来的是"封号立刻生效"与"缓存写失败不会导致权限不生效"两个性质）。若 Lead 或 D1 认为「权限集合应该有自己的一份缓存（例如角色级缓存，10 分钟 TTL）」，那 §6.2 的 `Resolve`、§6.3 的条目形状、§8.3 的 `loadActor` 三处要一起改，而 **`Resolve` 的 SQL 与 §8.3 的 `loadActor` SQL 里那段 JOIN 逻辑本来就有重叠**——有人会合理地提出"合并成一条 SQL、一次查库"。合并的代价是每次未命中要付两倍的 JOIN 成本，而现在的写法让"缓存命中"这条路只读 Redis。
