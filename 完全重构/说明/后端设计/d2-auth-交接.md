# D2 交接单（auth / authz / user）—— 对外接口、依赖、未决问题

> 配套文档：`完全重构/后端设计/d2-auth.md`（设计本体）。本文件只列**接口签名与依赖**，实现细节看设计文档对应章节。
> 本域**没有写一行 Go 代码、没有改 go.mod、没有生成 ent 代码**（本轮交付 = 设计）。
> **修订记录**：2026-10-13 按拍板 §9（注册激活）/ §9.9 + §9.12（U1–U21 裁决）/ §11（邮箱激活改 6 位验证码）更新。改动清单见本文件第 7 节；设计本体的逐条对应关系见 `d2-auth.md` §17.0。

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
    EmailVerified bool   // 只用于展示与"能不能再要一个验证码"；不挡任何功能（拍板 §9.12）
    Activated     bool   // ← 唯一的写闸门：false → 403 auth.not_activated
    Status        string
}

func Require(a *Actor, perm string) error          // 危险写操作的 service 层兜底（队列/cron/CLI 只靠它）
func HasAny(a *Actor, perms ...string) bool        // PermAny 中间件用
func CanInBoard(a *Actor, boardID int64) bool      // 分区作用域判定（forum 调）

// 权限点常量 + 目录
func All() []string                                // 25 个 key，排序（24 + resource.publish）
type PermMeta struct{ Key, Group, Name, Description string }
func Catalog() []PermMeta                          // 后台勾选界面用（grp 分组 + 中文名）
```

**它不碰数据库、不碰 gin**。任何模块都能 import，不会形成环。

### 1.2 `internal/auth` Service（本域内部用；`deps.go` 的小接口是别的模块用的）

```go
type Service struct{ /* cfg, db, dbRead, kv, limiter, queue, clock, log, hasher, touch */ }

func NewService(cfg config.Auth, db, dbRead *ent.Client, kv KV, limiter Limiter,
                q Queue, clk clock.Clock, log *slog.Logger, users UserLookup, mail MailAccounts) *Service

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
func (s *Service) RequireActivated() gin.HandlerFunc                // 登录 + activated_at 非空（写闸门，拍板 §9.12）
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
func (s *Service) ResendVerify(ctx context.Context, actor *authz.Actor, ip netip.Addr) (*ResendResult, error)
func (s *Service) VerifyEmailCode(ctx context.Context, in VerifyCodeInput) error            // { username|email, code }
func (s *Service) ForgotPassword(ctx context.Context, email string, ip netip.Addr) error    // 恒 nil
func (s *Service) VerifyResetCode(ctx context.Context, in VerifyCodeInput) (*ResetTicket, error) // 不消费码
func (s *Service) ResetPassword(ctx context.Context, in ResetPasswordInput) error           // { reset_ticket, new_password }

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
type VerifyCodeInput       struct{ Login, Code string; IP netip.Addr }   // Login = username 或 email
type ResetTicket           struct{ Ticket string; ExpiresAt time.Time } // Redis auth:pwreset:<ticket>，10 分钟、GETDEL 一次性
type ResendResult          struct{ ResendAfter int }                     // 秒；前端拿它做倒计时。**没有"模式"字段**（模式是全局配置，见拍板 §12）
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
    // U12/U20 定案：默认头像"分一次就固定"。media 在它的读写路径上调这个，写 users.default_avatar_hash；
    // 本域只提供列与索引（users 表由 auth 写，这一列由这个接口写 —— 见 §2.3）
    SetDefaultAvatar(ctx context.Context, userID int64) (hash string, err error)
}
```

---

## 2. 我需要别人提供的东西

### 2.1 D1（平台层与组装层）

| 能力 | 形状 | 备注 |
|---|---|---|
| 事务 | `db.WithTx(ctx, c, fn)` | 本域所有多表写都用它 |
| 缓存 | `kv.Cache`，需要 `GetInt64 / Incr(key, ttl) / Get / Set / Del` | 只要这五个方法；epoch 用 `Incr`，条目用 `Get/Set` |
| 限流 | `ratelimit.RateLimiter`：`Allow(ctx, key, limit, window) (bool, time.Duration, error)` | 本域的 key 见设计 §9.5；验证码校验另有一个**按账号的失败窗口**：`auth:mail:verify:user:<id>` 10 次/15 分钟（拍板 §11.4） |
| 队列 | `queue.Queue.Enqueue`（事务外）与 `EnqueueTx`（事务内） | 邮件任务类型常量放 `platform/queue/types.go`，payload `{"id":<userID>}` |
| 邮件 | 只需要「入队」这一条：`mail:send` 任务 + 模板 id `verify_code`（验证码）/ `reset_code` | **业务代码不许直接发信**（方案 §15.10）。**邮件正文里不给链接**（拍板 §11.2） |
| 发信能力查询 | `MailAccounts`（本域 deps.go 定义）：`HasUsable(ctx) (bool, error)` | **注册与重发要同步判**（拍板 §12.2）：`auto_activate=true` 且一个可用账号都没有 → **注册直接 503 `auth.mail_unavailable` 并回滚**（不建账号、不写任何降级状态）；`auto_activate=false` 时重发也返回它。**额度满不算不可用**（额度会恢复）。由 `mail` 的 Router 实现 |
| 自检的例外说明 | `user_permissions` **故意没有指向 users 的外键**（提权记录不能因为删用户而消失），所以 §14.3 的全库外键索引自检不会要求它建索引——这不是漏 | 见设计 §5.7 |
| 时钟 | `clock.Clock`；`clock.Fake` 必须能冻结时间 | 会话过期、令牌过期、touch 节流全靠它 |
| 错误 | `apperr.Error{Code,Status,Msg,Fields}` + `Invalid(fields)` | 本域新增的 **15** 个码见设计 §15.2（含 `auth.not_activated` / `auth.mail_unavailable` / `auth.activation_is_manual` / `auth.too_many_requests`；**`auth.email_unverified` 已作废**）。注意 **403 与 503 的分工**：策略决定用 403（`activation_is_manual`），配置错误用 503（`mail_unavailable`） |
| HTTP | `httpx.Bind / OK / Created / Fail`；`httpx.Fail` 负责 500 + request_id | **我要一个例外**：审计导出的 handler 自己写 `c.Writer`（CSV 流式） |
| ID | `idgen.NewPublicID()`（UUID v7）、`idgen.RandomToken(n)`、`idgen.NumericCode(6)`（6 位数字，**crypto/rand**） | DB 不设默认值；**会话表也要 public_id**（U13） |
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
| 实现 `user.AvatarURL` 接口（**两个方法**） | `Avatar`：`GET /users/{handle}` 返回 `/img/<hash>` 完整路径而不是裸 hash（U15 定案 + 开发必读 §12「路径只能有一个来源」）；`SetDefaultAvatar`：默认头像"分一次就固定"（U12 定案），写 `users.default_avatar_hash` |
| **U20 已定案：头像（改/删）归 media，`/me` 的纯文本字段（nickname/bio）归 user** | 两个模块**各写各的列**，不许互相 UPDATE。具体：`users.avatar_hash`/`avatar_small_hash`/`default_avatar_hash` 三列由 media 写；`nickname`/`bio`/`status`/`role_id`/`password_hash`/`email*`/`activated*`/`exp`/`level` 由 auth/user 写。**这两组列没有任何一列重叠**——那正是这条定案的意义 |
| 收款码 | 同上：`payment_channels` 表的写全归 media；本域不碰 |

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
| **全部（写路由）** | `authSvc.RequireActivated()` 中间件 | **写闸门**：`activated_at IS NULL` → 403 `auth.not_activated`（拍板 §9.12）。forum / media / message / reward 的写路由必须挂它；`actor.EmailVerified` **不要拿来挡功能**（它只影响展示与"能不能再要一个验证码"） |

**不要再实现一遍的东西**：密码哈希与校验、会话解析、权限集合计算、审计写入、`lower(col)=lower($1)` 的查询写法、**邮箱验证码的生成/校验/试错上限**（§10）。

---

## 4. 已知的短暂不可用（不要照抄成本域端点）

| 端点 | 归属 | 说明 |
|---|---|---|
| `GET /admin/users`、`GET /admin/users/{id}` | **独立 admin 模块**（U14 已定案） | 它跨 user/forum/reward 多个域，放 user 里会让 user 依赖所有人。本域只出它要用的 `Perms`/`RoleItem` 与审计数据 |
| `POST /admin/users/{id}/sanctions`（分区禁言） | D3 | `sanctions` 表在论坛域；权限点 `user.mute` 在本域的常量表里 |
| `GET/PATCH /admin/site-settings`、`/admin/diagnostics` | D1 | `site.setting` 权限点在本域的常量表里 |
| `GET/PATCH /admin/mail/*` | 邮件域 | `mail.manage` 同上 |
| `PATCH /admin/users/{id}/role` 的**界面** | 前端 | 端点在本域（§9.5） |

---

## 5. 待办 / 交接检查单

- [x] Lead 拍 U1–U21：**已全部拍完**（拍板 §9.9 / §9.12），设计文档已按裁决改完，逐条对应关系见设计 §17.0；
- [ ] **Lead 回写：拍板 §1.2 的表补上 `resource.publish` 这一行**（U1/U2 定案是 25 个，表里现在只有 24 行）；
- [ ] **Lead 决定 `topic.feature` 的归处**：拍板 §10.8 记着「P1b 已落库 24 个，`topic.pin` 兼管 `/feature`」，而 §9.9 又要求 25 个 —— 两条并存时 `topic.feature` 是一个永不生效的勾。**A** 补迁移 + `/feature` 改用 `topic.feature`；**B** 退回 24 个。选定前 §14.1 的启动自检会红；
- [ ] Lead 回写：方案 §3 目录树补 `internal/auth/pgsql`、`internal/user/pgsql`（U5 定案：放业务模块下）；
- [ ] Lead 回写：方案 §21.4 删除 `auth.email_unverified`、补本域新增的 **15** 个码（含 `auth.not_activated` / `auth.mail_unavailable` / `auth.activation_is_manual` / `auth.too_many_requests`）；
- [ ] Lead 回写：方案 §9.1 那句「注册必须完成邮箱验证才能登录」→「注册后需**激活**才能发帖；未激活可登录以便重发验证码」（拍板 §9.12 已给出措辞）；§21.2 的 `/auth/email/verify` 入参改成 `{username|email, code}`，并补 `/auth/password/verify-code`；
- [ ] Lead 回写：数据库文档 §4.1 的 `email_tokens` 补 `attempt_count`/`last_attempt_at`，`used_at` 改名 `consumed_at`；`users` 补 `default_avatar_hash`（拍板 §8.8）。**`activation_pending` 已被拍板 §12 删除**——数据库文档不要写它；若某个已提交的迁移加过这一列，按拍板 §12.5 新增一条 `ALTER TABLE users DROP COLUMN activation_pending`；
- [ ] Lead 回写：拍板 §9.2 状态机里「点链接 POST /auth/email/verify { token }」→「输入 6 位码」（拍板 §11.9 自己列了这条）；
- [ ] D1 确认 `mixin/time.go`、`generate.go` 的 `sql/lock`、`idgen.parsePublicID`+`idgen.NumericCode`（6 位数字，crypto/rand）、`auth.*`/`user.*` 配置项，以及 `MailAccounts.HasUsable` 这个能力从哪来（它是注册与重发路径上的**同步**判定，不能等队列任务告诉你"发不出去"）；
- [ ] D3 确认 `board_moderators` 的列与 `user_id` 单列索引 + 回调 `InvalidateUser`；写路由挂 `RequireActivated()`；
- [ ] D4 确认 `user.AvatarURL` 的两个方法（含 `SetDefaultAvatar`）与"头像列归 media 写"的列划分（U12/U15/U20）；
- [ ] 前端确认 `GET /me/sessions` 的字段集（U21 已定案：`id`(public_id)/`ip`/`user_agent`/`last_seen_at`/`created_at`/`is_current`）与 `GET /me` 的 `extra` 形状；
- [ ] **前端按拍板 §12.5 做两种未激活文案**：`auto_activate=true` → 「验证码已发到邮箱」+ 重发按钮；`false` → 「等待管理员激活」+ **不显示重发按钮**（两个文案由同一个开关派生，不要引入第三态）；
- [ ] **D1（site 模块）**：`site_settings` 的键 `auth.registration.auto_activate`（默认 true）要能在后台「站点设置」里改，并且**不插默认行**（缺行即 true，见设计 §10.1）；

---

## 6. 未决问题（完整列表见 `d2-auth.md` §17）

| 编号 | 定案（拍板 §9.9 / §9.12） |
|---|---|
| U1 | **24 + `resource.publish` = 25**（表头"23"是笔误） |
| U2 | **要**：发 `kind='resource'` 时多要一条（forum 的 service 判） |
| U3 | **要** `roles.is_super`，不许比较 `role.key` |
| U4 | **要** `idx_users_nickname_lower` |
| U5 | **`internal/auth/pgsql`**（业务模块下） |
| U6 | **能登录**；写闸门只有 `auth.not_activated`；`auth.email_unverified` **作废** |
| U7 | 照 §10.2 映射；未激活者用**同一个** `auth.not_activated`，不特判 |
| U8 | **读时闭包**（`WITH RECURSIVE chain`） |
| U9 | **给** admin |
| U10 | **要写**（`audit.export` 自己留痕） |
| U11 | **不做**登录去重 |
| U12 | **要** `users.default_avatar_hash` + 单列 FK 索引 |
| U13 | **public_id**（sessions 加这一列） |
| U14 | **独立 admin 模块** |
| U15 | **`/img/<hash>` 完整路径** |
| U16 | CHECK 保留 `'deleted'`，**端点不做** |
| U17 | **不交叉判** |
| U18 | **写入时算并存** `depth` |
| U19 | **要**，谓词 `WHERE consumed_at IS NULL`（**不带 now()**） |
| U20 | `/me` 纯文本归 user、**头像归 media**，各写各的列 |
| U21 | `id`/`ip`/`user_agent`/`last_seen_at`/`created_at`/`is_current`，**不回 token** |

**我在本轮之后仍然认为最可能被推翻的一处**：设计 §17.0 末尾那条 —— **`topic.feature` 到底留不留**。它现在同时出现在「P1b 已落库的 24 个」与「§9.9 要求补到 25 个」里，而 `/feature` 端点判的是 `topic.pin`；不定它，§14.1 的启动自检永远红。

**（上面这段是设计阶段的判断，2026-10-13 复核后仍然成立）**

---

## 7. 本轮修订清单（2026-10-13，按拍板 §9 / §9.9 / §9.11 / §9.12 / §11 / **§12**）

| 改了什么 | 影响面 |
|---|---|
| 写闸门从 `email_verified_at` 换成 `activated_at`；`RequireVerified()` → `RequireActivated()`；`auth.email_unverified` 作废 | 设计 §9.3（整节重写）、§9.2 路由说明、§6.4 中间件顺序、§15 错误码、§18 测试 |
| ~~新增 `users.activation_pending` 状态机 + 两条激活路~~ **已作废**（2026-10-13，拍板 §12）：字段删除、模式改由 `site_settings` 的 `auth.registration.auto_activate` 决定 | 设计 §5.1（列已删）、§10.1（两种模式 + 读开关）、§10.3（503 且注册回滚）、§10.5、§17.2（四问）、§18.4 第 44–46d 条 |
| 邮箱激活改 6 位验证码：`attempt_count`/`last_attempt_at`、10 分钟、5 次作废、15 分钟 10 次 429、统一文案、邮件不给链接 | 设计 §5.3 表、§10.2–§10.5、§9.5 路由表、§15 错误码 |
| 找回密码改成「验证码 → reset_ticket → 设新密码」两步 | 设计 §10.6、§9.5 路由表（新增 `/auth/password/verify-code`） |
| 新增 `users.default_avatar_hash`（U12） | 设计 §5.1 列与索引、§10.7 分配规则、交接单 §2.3 |
| `sessions` 加 `public_id`（U13） | 设计 §5.2、§9.5 |
| 权限点 24 → 25（补 `resource.publish`），角色权限数 3/8/18/25 | 设计 §8.6、§14.2、§18.2、§18.9 |
| `email_tokens.used_at` → `consumed_at`（U19 的谓词用词） | 设计 §5.3、§5.10、§10 |
| `audit.export` 自己写审计（U10） | 设计 §8.10 动作清单 |
| `/me` 纯文本归 user、头像归 media（U20） | 设计 §9.3、交接单 §2.3 |
