# D4 交接单：通知 / 私信 / 头衔与等级（notify / message / title）

> 配套设计：`完全重构/后端设计/d4-social.md`（本文只放**接口与依赖**，规则与 SQL 在那份里）。
> 用途：Lead 按这份派单；下游模块按「我欠谁什么 / 谁欠我什么」对齐。
> 本文所有签名以设计文档为准，实现时若发现签名不对，**先改设计文档再改代码**。

---

## 1. 我对外暴露的 Go 接口（下游可依赖的部分）

### 1.1 `internal/notify`

```go
type Service struct{ /* 私有字段 */ }

func NewService(db, dbRead *ent.Client, clk clock.Clock, q queue.Queue,
	pg *pgsql.Queries, users UserLookup, settings NoticeSettings) *Service

// —— 业务写入方（forum / reward）在**自己的事务里**调用 ——
func (s *Service) Create(ctx context.Context, tx *ent.Tx, in CreateInput) error

// —— HTTP handler 用（actor 显式传入，拍板 §5.3）——
func (s *Service) List(ctx context.Context, actor *authz.Actor, in ListInput) (*ListResult, error)
func (s *Service) UnreadCount(ctx context.Context, actor *authz.Actor) (int, error)
func (s *Service) MarkRead(ctx context.Context, actor *authz.Actor, in MarkReadInput) (int, error)
func (s *Service) Delete(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) SetMute(ctx context.Context, actor *authz.Actor, in MuteInput) error
func (s *Service) UnsetMute(ctx context.Context, actor *authz.Actor, in MuteInput) error

// —— 队列任务入口（app/worker.go 注册）——
func (s *Service) NotifyReply(ctx context.Context, in CreateNotifyInput) error
func (s *Service) NotifyMention(ctx context.Context, in CreateNotifyInput) error
func (s *Service) NotifyLike(ctx context.Context, in CreateNotifyInput) error
func (s *Service) NotifyReward(ctx context.Context, in CreateNotifyInput) error

func NewHandler(svc *Service) *Handler
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc)
```

对外类型：

```go
type CreateInput struct {
	UserID  int64  // 收件人
	ActorID int64  // 触发者；系统通知为 0 → NULL
	Kind    string
	RefType string // post | topic | comment | issue | donation | sanction | system
	RefID   int64  // 与 RefType 配对的内部 id；system 为 0
	TopicID int64  // 0 = 无；只用于拼 link 与渲染
	Link    string // 站内相对路径，'/' 开头
	Text    string // 仅 system
}

type CreateNotifyInput struct { // 任务 payload 解析后的形状，键与 payload 一一对应
	Kind    string
	ActorID int64
	RefType string
	RefID   int64
	TopicID int64
	UserID  int64 // 仅 mention 用（被提及者）
}

type ListInput struct {
	Kind       string // wire 面的 ?kind=
	UnreadOnly bool
	Cursor     string
	Limit      int
}
type MarkReadInput struct {
	PublicIDs []string
	All       bool
}
type MuteInput struct {
	Type    string // 类别，或 "link"（"link" 时下面两个字段才有意义）
	RefType string // "" | "post" | "topic" | "comment" | "issue" | "donation" | "sanction"
	RefID   int64
}
type ListResult struct {
	Items      []NotificationDTO
	NextCursor string // "" = 到底
}
type NotificationDTO struct {
	ID       string // public_id
	Kind     string // JSON 字段名 kind（列名是 type，见设计 §12）
	Payload  map[string]any
	Link     string
	ReadAt   *time.Time
	CreatedAt time.Time
	Actor    *UserBrief // nil = 已注销
}
```

常量（**一处定义**，取值必须与 CHECK / 迁移同名）：

```go
// internal/notify/kinds.go
const (
	KindReply    = "reply"
	KindMention  = "mention"
	KindLike     = "like"
	KindReward   = "reward"
	KindReview   = "review"
	KindSanction = "sanction"
	KindSystem   = "system"
	KindLink     = "link" // 仅 notification_mutes.type 用
)

// internal/platform/queue/types.go（**加在这份文件里**）
const (
	TypeNotifyReply    = "notify:reply"
	TypeNotifyMention  = "notify:mention"
	TypeNotifyLike     = "notify:like"
	TypeNotifyReward   = "notify:reward"
	TypeNotifyReview   = "notify:review"   // 审核结果（forum 的 post.review 队列）
	TypeNotifySanction = "notify:sanction" // 处罚（admin 禁言）
)

// internal/notify/keys.go —— dedup_key 与静音 target_key 的唯一生成处
func RefKey(refType string, refID int64) string // "post:42" / "comment:88"
func DedupKey(kind, refType string, refID int64) string // "reply:post:42" / "mention:comment:88"
```

任务 payload 形状（JSON，只放 id）：

```json
{"ref_type": "post", "ref_id": 42, "topic_id": 7, "actor_id": 5}                    // reply / like
{"ref_type": "post", "ref_id": 42, "topic_id": 7, "actor_id": 5, "user_id": 99}      // mention（楼层）
{"ref_type": "comment", "ref_id": 88, "topic_id": 7, "actor_id": 5, "user_id": 99}   // mention（issue 评论）
{"ref_type": "donation", "ref_id": 12, "actor_id": 5}                                // reward
{"ref_type": "topic", "ref_id": 7, "actor_id": 0}                                    // review
{"ref_type": "sanction", "ref_id": 3, "actor_id": 5}                                 // sanction
```

### 1.2 `internal/message`

```go
func NewService(db, dbRead *ent.Client, clk clock.Clock, pg *pgsql.Queries,
	users UserLookup, blocks BlockReader) *Service

func (s *Service) ListConversations(ctx context.Context, actor *authz.Actor, in PageInput) (*ConversationPage, error)
func (s *Service) ListThread(ctx context.Context, actor *authz.Actor, in ThreadInput) (*ThreadPage, error)
func (s *Service) Send(ctx context.Context, actor *authz.Actor, in SendInput) (*MessageDTO, error)
func (s *Service) MarkThreadRead(ctx context.Context, actor *authz.Actor, peerHandle string) (int, error)
func (s *Service) DeleteMessage(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) UnreadTotal(ctx context.Context, actor *authz.Actor) (int, error)

func NewHandler(svc *Service) *Handler
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc)
```

对外类型：

```go
type PageInput struct{ Cursor string; Limit int }
type ThreadInput struct{ PeerHandle, Cursor string; Limit int }
type SendInput struct{ PeerHandle, Body string }

type ConversationPage struct {
	Items      []ConversationDTO
	NextCursor string
}
type ConversationDTO struct {
	Peer        UserBrief
	UnreadCount int
	Last        MessageDTO
}
type ThreadPage struct {
	Peer       UserBrief
	Items      []MessageDTO
	NextCursor string
}
type MessageDTO struct {
	ID        string // public_id
	Body      string
	Mine      bool
	Read      bool
	CreatedAt time.Time
}
```

### 1.3 `internal/title`

```go
func NewService(db, dbRead *ent.Client, clk clock.Clock, audit AuditSink) *Service

func (s *Service) ListTitles(ctx context.Context) ([]TitleDTO, error)
func (s *Service) UserTitles(ctx context.Context, userID int64) (*UserTitlesDTO, error)
func (s *Service) Equip(ctx context.Context, actor *authz.Actor, titlePublicID string) error // "" = 取消佩戴
func (s *Service) AssignTitle(ctx context.Context, actor *authz.Actor, in AssignInput) error
func (s *Service) CreateTitle(ctx context.Context, actor *authz.Actor, in TitleInput) (*TitleDTO, error)
func (s *Service) UpdateTitle(ctx context.Context, actor *authz.Actor, in TitleInput) (*TitleDTO, error)
func (s *Service) AddExp(ctx context.Context, actor *authz.Actor, in AddExpInput) (*ExpDTO, error)

func NewHandler(svc *Service) *Handler
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin, perm gin.HandlerFunc)
```

对外类型与函数：

```go
type AssignInput struct {
	UserID        int64
	TitlePublicID string
	Revoke        bool
}
type TitleInput struct {
	PublicID, Key, Name, Color, Description string
	Archived                                bool
}
type AddExpInput struct{ UserID int64; Delta int; Reason, Ref string }

type TitleDTO struct {
	ID          string // public_id
	Key, Name, Color, Description string
	ArchivedAt  *time.Time
}
type UserTitlesDTO struct {
	Items        []TitleDTO
	EquippedID   string // "" = 未佩戴
}
type ExpDTO struct{ Exp, Level int }

// 等级公式的唯一 Go 实现：写 users.level 与测试都走它（设计 §4.13）
func LevelForExp(exp int) int

const (
	ReasonManual   = "manual"
	ReasonRegister = "register"
	ReasonTopic    = "topic"
	ReasonReply    = "reply"
	ReasonLike     = "like"
	ReasonReward   = "reward"
	ReasonImport   = "import"
)
```

### 1.4 `internal/platform/mention`（平台包，new）

```go
type Mention struct{ UserID int64; Nickname string }

const MaxPerBody = 20

func Parse(md string) []Mention                     // 按出现顺序、按 UserID 去重；不查库
func CheckLimit(ms []Mention) error                 // > 20 → 400 content.bad_mention
func Rewrite(html string, names map[int64]string) string

// errs.go
var ErrBadMention = apperr.New(400, "content.bad_mention", "提及的用户不存在或已封禁")
```

### 1.5 `internal/user` 的搜索（本域交付 SQL 与索引，实现归 user）

```go
func (s *Service) Search(ctx context.Context, actor *authz.Actor, in SearchUsersInput) ([]UserSearchDTO, error)
type SearchUsersInput struct{ Q string; Limit int } // Limit 默认 8、上限 20
type UserSearchDTO struct {
	PublicID, Handle, Nickname, Avatar, AvatarSmall string
	Dup                                             bool
}
```

---

## 2. 我依赖别人的什么（对方要提供的确切形状）

### 2.1 依赖 forum（`internal/forum`）

| 我要的 | 形状 | 用在哪 |
|---|---|---|
| 五个事件点必须在**同一事务**里 `EnqueueTx` | 见设计 §5.1 的 ①–⑤ | 通知的产生前提 |
| 提及解析必须在**写入时**做 | 存 `content_md` 的同一个请求里调 `mention.Parse`，并对 id 批量校验 | 否则「改昵称后通知指向错人」 |
| **提及有两个来源**，都要入队 | 帖子正文（`ref_type="post"`，1 楼也是 post）与 issue 评论（`ref_type="comment"`） | 漏一个来源 = 那处 @ 永远不通知，且测试发现不了（只测帖子正文会全绿） |
| `BlockReader` 的实现 | `BlockedBetween(ctx, a, b) (aBlockedB, bBlockedA bool, err error)` | message.Send 的拉黑判定（设计 §4.9） |
| `likes.target_type` 含 `topic` | 主题赞也要发通知 | 通知对象 = `topics.author_id` |

**forum 需要我提供的**：`*notify.Service`（构造时由 app 注入）+ 四个任务类型常量。
**forum 不要直接 import `internal/notify`**（后端方案 §4.2 第 3 条）：它只调 `queue.EnqueueTx`，由 app 层把 `notify.Service` 给 worker。

### 2.2 依赖 user（`internal/user`）

| 我要的 | 形状 |
|---|---|
| 单人资料 | `GetBrief(ctx, id) (*UserBrief, error)`；不存在返回 `user.ErrNotFound` |
| 批量资料 | `GetBriefs(ctx, ids []int64) (map[int64]*UserBrief, error)`；空输入返回**空 map**（不是 nil） |
| 按 handle 查 | `ByUsername(ctx, username) (*UserBrief, error)` |
| 通知设置 | `NoticeSettings.Get(ctx, userID) (*NoticeSetting, error)`：`{Alert bool; ReplyScope, MentionScope string; LikeAlert bool}` |
| 搜索实现 | 设计 §4.14 的 SQL + 新索引 `idx_users_nickname_lower (lower(nickname))` |

**`UserBrief` 的形状两处各定义一份**（notify/deps.go 与 message/deps.go），字段完全相同：`{ID int64; Handle, Nickname, Avatar, AvatarSmall string}`。`Avatar`/`AvatarSmall` 是 `/img/<hash>` 形式的 URL，**空字符串表示没有头像**（前端回落默认头像，后端不拼默认池，见设计 §0 的不做清单）。

**user 需要我跟进的**：`user_notice_settings` 的列与默认值在数据库设计 §4.5 已定；`reply_scope='followed'` 的取舍见设计 §11 U9（**需 Lead 定**，因为表在 user 域）。

### 2.3 依赖 reward（`internal/reward`）

| 我要的 | 形状 |
|---|---|
| 核验通过时投递 | `EnqueueTx(queue.Task{Type: TypeNotifyReward, Payload: {"donation_id": id}})`，与「state=approved」写在同一事务 |
| 任务里回查 | 我只读 `donation_records` 的 `(id, donor_id, recipient_id, amount_cents, state)` |

**注意**：设计里 `notify:reward` 的任务会在收件人是 donor 自己时报错——打赏域已有 `donor ≠ recipient` 的 CHECK，所以不会发生，notify 侧不做防御（不写不可能的分支）。

### 2.4 依赖平台层

| 能力 | 包 | 我要的方法 |
|---|---|---|
| 事务 | `platform/db` | `WithTx(ctx, c, fn) error` |
| 队列 | `platform/queue` | `Queue.EnqueueTx(ctx, tx, Task) error`；类型常量加进 `types.go` |
| 时间 | `platform/clock` | `Clock.Now() time.Time`（业务代码禁止 `time.Now()`） |
| 错误 | `platform/apperr` | `New(code, status, msg)`、`Invalid(fields)` |
| 对外 ID | `platform/idgen` | `NewPublicID() string`、`ParsePublicID(s) (int64, error)` |
| 原生 SQL | `platform/search/pgsql` | 新增 `social.sql`（设计 §4 的 14 条查询）；本域不用 `tsvector` |
| markdown | `platform/markdown` | 需要一次改动：把 `mention.Rewrite` 接在 goldmark 之后、bluemonday 之前（设计 §11 U7） |
| 邮件 | `platform/mail` | **本域不调**（不做通知邮件）。留的调用点是 `mail:send` 任务的 `MailLog.idempotency_key = 'notify:<kind>:<dedup_key>'`，真要做时按后端方案 §8.4 走，**不改 mail 实现** |

### 2.5 依赖审计（`internal/audit`）

`title` 的三个写操作必须写审计（提权是攻击者第一目标，拍板与后端方案 §9.8 都要求）：

| action | 何时 |
|---|---|
| `title.grant` | `AssignTitle` 且 `Revoke=false` |
| `title.revoke` | `AssignTitle` 且 `Revoke=true` |
| `title.manage` | `CreateTitle` / `UpdateTitle` |

`AuditSink` 的形状（本包 deps.go 定义，由 app 注入 `*audit.Service`）：

```go
type AuditSink interface {
	Log(ctx context.Context, e audit.Entry) error
}
// audit.Entry 由 audit 包定义：{ActorID int64; Action string; TargetType, TargetID string; Detail map[string]any; IP string}
```

> **`Equip` 不写审计**：佩戴自己的头衔不是提权，也不是管理动作。这条写下来是为了以后不要「顺手补一条」。

### 2.6 依赖图片（前端约定，不是后端）

通知列表/私信列表返回的 actor/peer 里 `avatar` 为空字符串时，**前端回落默认头像**（数据库设计 §4.4 的 `default_avatars` 池）。后端**不**做 `id % pool_size` 的拼装：本域三个列表一次最多返回 20 个用户，为它们各查一次池子毫无意义，而前端已经有一个头像回落点（`src/ui/user-badge.tsx`）。

---

## 3. app 层接线（`internal/app/modules.go` 与 `worker.go`）

```go
// modules.go，顺序：被依赖的先创建
m.User    = user.NewService(...)
m.Forum   = forum.NewService(..., in.Queue, ...)
m.Notify  = notify.NewService(in.DB, in.DBRead, in.Clock, in.Queue, pg, m.User, m.User)
m.Message = message.NewService(in.DB, in.DBRead, in.Clock, pg, m.User, m.Forum)
m.Title   = title.NewService(in.DB, in.DBRead, in.Clock, m.Audit)

// worker.go
in.Worker.Handle(queue.TypeNotifyReply,   func(ctx context.Context, b []byte) error { ... m.Notify.NotifyReply(...) })
in.Worker.Handle(queue.TypeNotifyMention, ...)
in.Worker.Handle(queue.TypeNotifyLike,    ...)
in.Worker.Handle(queue.TypeNotifyReward,  ...)

// http.go
m.Notify.Register(v1, auth.RequireLogin())
m.Message.Register(v1, auth.RequireLogin())
m.Title.Register(v1, auth.RequireLogin(), auth.Perm)
m.User.Register(v1, auth.RequireLogin(), auth.Perm)

// cron.go：两条清理（设计 §5.5），每天一次
```

`pg *pgsql.Queries` 是 `platform/search/pgsql` 暴露的查询集。若它现在只暴露搜索相关方法，本域新增的 `social.sql` 与对应方法**加在同一个包里**（原生 SQL 的唯一合法落点之一，开发必读 §1 第 8 条）。

---

## 4. 迁移与索引清单（给写迁移的人）

**新增表 6 张**：`notifications`、`notification_mutes`、`messages`、`titles`、`user_titles`、`exp_events`。
**改 users**：加 `equipped_title_id` / `exp` / `level` 三列 + `idx_users_equipped_title`。
**改 users 索引**：加 `idx_users_nickname_lower (lower(nickname))`。

**必须手写（ent 生成不了）**：

1. 全部 CHECK：`ck_notifications_type`、`ck_notifications_link_prefix`、`ck_notifications_dedup_prefix`、`ck_notification_mutes_type`、`ck_notification_mutes_key`、`ck_messages_pair_order`、`ck_messages_sender_in_pair`、`ck_messages_body_not_blank`、`ck_titles_key`、`ck_titles_color`、`ck_titles_name`、`ck_user_titles_not_self`、`ck_exp_events_delta_nonzero`、`ck_exp_events_reason`、`ck_exp_events_ref`。
2. 部分索引 8 个：`idx_notifications_inbox`、`idx_notifications_unread`、`uq_notifications_user_dedup`、`idx_messages_unread_low`、`idx_messages_unread_high`、`uq_exp_events_user_reason_ref`（+ `idx_messages_pair_high` 若 ent 侧顺序表达不出 DESC，也手写）。
3. 表达式索引 1 个：`idx_users_nickname_lower`。
4. `users` 三列一律用 `ALTER TABLE ADD COLUMN`（**不是**重建表）；`exp`/`level` 是 `NOT NULL DEFAULT 0/1`，`equipped_title_id` 可空。
5. **迁移模板加 `SET lock_timeout='3s'; SET statement_timeout='30s';`**（盲审 M8），加列/加 CHECK 都是 ACCESS EXCLUSIVE。

**不需要**：新扩展（`pg_trgm` 由搜索域的第一个迁移已建）、触发器、生成列、seed 数据（头衔目录由管理员在后台建，**不预置任何头衔**——与「不预置屏蔽词」同一个理由：不给用户预设我们觉得合适的东西）。

---

## 5. 本域对别人的三处「要求改动」（需要 Lead 拍）

| 谁 | 改什么 | 为什么 |
|---|---|---|
| §21.2 端点表 | 补 `GET /api/v1/messages/unread-count`、`DELETE /api/v1/notifications/mutes`；删 `GET /api/v1/messages/stream` | 设计 §11 U1 / U2 / U4 |
| §21.4 错误码表 | 补 `content.bad_mention` 400、`message.blocked` 403 | 设计 §7 |
| 性能与容量 §4.2 / §7 + 数据库设计 §4.11 | 删掉 standard 档 SSE 的说法 | 与后端方案 §20.3、拍板 §6 的「明确不做 SSE」冲突；**只改代码不改文档 = 第二份真源** |

---

## 6. 未决问题（同设计 §11，这里只留需要别人拍板的）

| 编号 | 要谁拍 | 问题 |
|---|---|---|
| U1 | Lead | 加 `DELETE /notifications/mutes`（取消静音）——不加就是单向门 |
| U2 | Lead | 加 `GET /messages/unread-count`——不加则顶栏 30 秒拉整页会话列表 |
| U3 | 本域 | 是否预建 `(user_id, type, created_at DESC, id DESC)`；默认不建，阈值 5000 行写在设计 §4.1 |
| U4 | Lead | SSE 去留：本设计按「不做」执行，翻案要同时改三份文档 |
| U5 | 产品 | exp 发放规则（A 手动 / B 自动 / C 自动+上限），见设计 §6.4 |
| U6 | 本域 | `message.too_long` 是否单列错误码；倾向并入 `common.invalid_input` |
| U7 | 实现者 | 先花 10 行验证 `mention:` 能否活过 bluemonday；这决定改写插在哪一步 |
| U8 | Lead | `notification_mutes` 的 schema 归 notify 还是 user；倾向 notify |
| U9 | Lead + user 域 | `user_notice_settings.reply_scope` 里的 `followed`：现在没有「关注」功能，倾向删掉该值 |
| U10 | 产品 | 私信要不要邮件提醒；本设计不做 |
| U11 | 处罚域 | `sanctions.board_id` 的全局哨兵（NULL vs 0）；本域只读不写 |
| U12 | 前端 | 「关掉横幅」与「不再通知」是两套，文案要写清 |

另：**Atlas diff 会想 DROP 本域的手写对象**（盲审 B6）。请把上面 §4 的 8 个部分索引 + 1 个表达式索引加进「必需索引存在性」白名单断言，否则 CI 会长期红，或被人当噪声删掉。
