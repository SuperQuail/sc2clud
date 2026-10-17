# D4 设计：通知 / 私信 / 头衔与等级 / @提及 / 用户搜索

> 域：`notifications` / `notification_mutes` / `messages` / `titles` / `user_titles` / `exp_events`，模块 `internal/notify`、`internal/message`、`internal/title`，外加 `mail_logs` 的发信调用点（不改 mail 实现）。
> 优先级：`后端开工前拍板.md`（第 0 号决策）> 本文 > `数据库设计-postgresql.md` §4.5/§4.11 > `论坛后端技术方案-v2.md` §21。
> 本文只写设计，不含 Go 代码；实现由 Lead 派单。

---

## 0. 做完了是什么样

| 能力 | 一句话 |
|---|---|
| 站内通知 | 回复 / @提及 / 点赞 / 打赏到账 / 审核结果 各产生一条通知；同一次事件重放**不会**产生第二条 |
| 未读角标 | 一次 `COUNT(*)` 走部分索引，不做全表 |
| 静音 | 「不再通知」按**类别**或**某条内容**；在生成时判，不产生行 |
| 私信 | 一对一，两侧各自删除互不影响，被拉黑发不出去，轮询 5s / 30s（**不做 SSE**） |
| 头衔 | 目录（key/name/color/description/归档）+ 多对多持有 + 佩戴一个 |
| 等级经验 | 经验流水表；`level = floor(sqrt(exp/100))+1` 是同事务写入的不变量 |
| @提及 | 只认 `[@昵称](mention:<user_id>)`；写时校验、渲染改写、通知去重、自己提自己不发 |
| 用户搜索 | `GET /api/v1/users/search?q=`，昵称前缀 + username，重名带 `dup` 标记 |

**本域不做**（写下来是为了不再讨论）：SSE / WebSocket、会话（conversation）表、私信 Markdown 渲染、私信邮件提醒、通知摘要邮件、通知聚合行、头衔删除、按会话静音/归档、exp 自动发放规则（见 §6.4）、`smart_block` 与 `block_words`。

---

## 1. 数据表

> §2 全局约定逐条遵守：identity 主键、`public_id` 由应用生成（DB 无默认）、时间一律 `timestamptz`、枚举一律 `text + CHECK`、布尔 `NOT NULL DEFAULT false`、外键显式建索引、每表 `created_at`、会变的表加 `updated_at`、有业务上限的文本用 `varchar(n)`。
> 下面片段可直接执行（先 `CREATE EXTENSION IF NOT EXISTS pg_trgm;`，见数据库文档 §5）。

### 1.1 notifications

```sql
CREATE TABLE notifications (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     uuid        NOT NULL UNIQUE,
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id      bigint          NULL REFERENCES users(id) ON DELETE SET NULL,
  type          varchar(16) NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  link          text        NOT NULL DEFAULT '',
  dedup_key     text        NOT NULL DEFAULT '',
  read_at       timestamptz     NULL,
  deleted_at    timestamptz     NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_notifications_type
    CHECK (type IN ('reply','mention','like','reward','review','sanction','system')),
  CONSTRAINT ck_notifications_link_prefix CHECK (link = '' OR link LIKE '/%'),
  CONSTRAINT ck_notifications_dedup_prefix
    CHECK (dedup_key = '' OR
           dedup_key ~ '^(reply|mention|like|reward|review|sanction):(post|topic|comment|issue|donation|sanction):[0-9]+$')
);

-- 收件箱（游标分页：ORDER BY created_at DESC, id DESC）
CREATE INDEX idx_notifications_inbox ON notifications (user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
-- 未读角标（一次 COUNT，只索引未读行）
CREATE INDEX idx_notifications_unread ON notifications (user_id)
  WHERE read_at IS NULL AND deleted_at IS NULL;
-- 外键索引（PG 不自动建；actor_id 不在任何索引前导位）
CREATE INDEX idx_notifications_actor ON notifications (actor_id);
-- 同一事件只有一条通知；软删**不**解除占用（否则重试会在用户删除后复活）
CREATE UNIQUE INDEX uq_notifications_user_dedup ON notifications (user_id, dedup_key)
  WHERE dedup_key <> '';
```

- `type` 值域 = Go 常量 `notify.Kind*`，两者必须同名（数据库文档 §12 第 4 条自检会解析 `pg_constraint`，所以 CHECK 与常量必须逐字一致）。
- `read_at` 与 `deleted_at` 语义完全分开：前者是「看过了」，后者是「只对我隐藏」。
- **不建 `updated_at`**：这张表没有「修改」语义，已读/已删是两根一次性时间轴。加了它，每次批量已读都会多写一列。
- `payload` 只放渲染这一条所需的最小形状，键固定为 `{"ref_type":"post","ref_id":42,"topic_id":7,"state":"approved","text":"…"}`，**不放快照**（昵称/头像在列表查询时 join 现取）。
- `ref_type` 是**被引用实体的表**，取值 `post` / `topic` / `comment` / `issue` / `donation` / `sanction` / `system`。
  它必须与 `dedup_key` 的前缀**同一个值**（都来自 `notify.RefKey(refType, refID)`），否则「重试不重复」与「静音按内容」会指向不同东西。
- 保留：`deleted_at < now() - interval '90 days'` 的行由 cron 分批硬删（§5.5）。不删的话部分索引里的死元组会拖慢未读 COUNT。

### 1.2 notification_mutes

```sql
CREATE TABLE notification_mutes (
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       varchar(16) NOT NULL,
  target_key varchar(64) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type, target_key),
  CONSTRAINT ck_notification_mutes_type
    CHECK (type IN ('reply','mention','like','reward','review','sanction','system','link')),
  CONSTRAINT ck_notification_mutes_key
    CHECK ((type =  'link' AND
             target_key ~ '^(post|topic|comment|issue|donation|sanction):[0-9]+$') OR
            (type <> 'link' AND target_key = ''))
);
```

一行两义，由 `type` 区分：

| 行 | 含义 | 匹配哪条通知 |
|---|---|---|
| `(u,'like','')` | 整个类别不再通知 | `type='like'` 的全部通知 |
| `(u,'link','post:42')` | 这条内容不再通知 | `payload->>'post_id'='42'` 或 `payload->>'topic_id'='42'` |

`target_key` 的编码是 `ref_type:internal_id`（例如 `post:42` / `topic:7` / `comment:88`），由 `notify.RefKey(refType, refID)` **一个函数**生成：`payload.ref_type + ":" + payload.ref_id`。写入与匹配都走它。
反过来，`target_key` 的前缀由**通知自己的 `payload.ref_type`** 决定，而不是由通知类型决定——所以「回复某帖不再通知」与「被赞某帖不再通知」共用同一个 key，而「回复某楼不再通知」与「回复某帖不再通知」是两个 key。
CHECK 里的前缀白名单必须与 `ref_type` 的值域逐字一致（数据库文档 §12 第 4 条的自检会比对）。

### 1.3 messages

```sql
CREATE TABLE messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid          NOT NULL UNIQUE,
  low_id          bigint        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  high_id         bigint        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id       bigint        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            varchar(2000) NOT NULL,
  read_at         timestamptz       NULL,
  deleted_by_low  boolean       NOT NULL DEFAULT false,
  deleted_by_high boolean       NOT NULL DEFAULT false,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_messages_pair_order     CHECK (low_id < high_id),
  CONSTRAINT ck_messages_sender_in_pair CHECK (sender_id IN (low_id, high_id)),
  CONSTRAINT ck_messages_body_not_blank CHECK (btrim(body) <> '')
);

-- 会话内翻页（游标：(id) < cursor，ORDER BY id DESC）
CREATE INDEX idx_messages_pair_low  ON messages (low_id,  high_id, id DESC);
-- 会话列表里「我是 high 那一侧」的锚点
CREATE INDEX idx_messages_pair_high ON messages (high_id, low_id,  id DESC);
-- 未读角标 / 批量已读（必须带 sender 条件与删除条件，见下）
CREATE INDEX idx_messages_unread_low  ON messages (low_id)
  WHERE read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id;
CREATE INDEX idx_messages_unread_high ON messages (high_id)
  WHERE read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id;
-- 外键索引（sender_id 不在任何索引前导位）
CREATE INDEX idx_messages_sender ON messages (sender_id);
```

**`sender_id <> low_id`（对称 `<> high_id`）是必需的**：`read_at` 是**收件人**的已读时间，漏掉它会让「我发给对方、对方还没读」的消息计进**我自己**的未读角标（盲审 B3）。同理 `deleted_by_*` 也要在谓词里，删掉的未读消息不该继续计数。

**「各自删除」用两条布尔列，不用两条行**：一条私信改一次状态；两行就要两倍的写与两倍的分页复杂度。删除时间不做保留期与恢复（不做就是不做，写在这里）。两侧都删了行仍在表里，等 §5.5 的 cron 硬删。

**不做会话表**：`(low_id, high_id)` 就是会话身份，规范化顺序由 CHECK 保证。

### 1.4 titles / user_titles / users 三列

```sql
CREATE TABLE titles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid        NOT NULL UNIQUE,
  key         varchar(32) NOT NULL UNIQUE,
  name        varchar(32) NOT NULL,
  color       varchar(16) NOT NULL DEFAULT '',
  description varchar(200) NOT NULL DEFAULT '',
  archived_at timestamptz     NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_titles_key   CHECK (key ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT ck_titles_color CHECK (color = '' OR color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT ck_titles_name  CHECK (btrim(name) <> '')
);

CREATE TABLE user_titles (
  user_id    bigint      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  title_id   bigint      NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  granted_by bigint          NULL REFERENCES users(id)  ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, title_id),
  CONSTRAINT ck_user_titles_not_self CHECK (granted_by IS NULL OR granted_by <> user_id)
);

-- 外键索引：主键的第二列 title_id、以及 granted_by，都不在任何索引前导位
CREATE INDEX idx_user_titles_title   ON user_titles (title_id);
CREATE INDEX idx_user_titles_granted ON user_titles (granted_by);

ALTER TABLE users ADD COLUMN equipped_title_id bigint NULL REFERENCES titles(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN exp  int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN level int NOT NULL DEFAULT 1;
CREATE INDEX idx_users_equipped_title ON users (equipped_title_id);  -- 外键索引（盲审 B2 点名漏过它）
```

**头衔只归档不删除**（`archived_at`）。`ON DELETE CASCADE` 只是兜底：`title.manage` 里没有删除操作，后台界面也不给。归档后：目录接口不返回它；已经持有的人仍然在 `/users/{handle}/titles` 里带着徽章（历史事实），但不能新佩戴。

**佩戴唯一**由 `users.equipped_title_id` 一个可空外键表达（数据库设计 §4.11），不新建表。`ON DELETE SET NULL` 正是旧站 `repo_titles.rs:128` 手工清 `equipped_title_id` 的那件事，现在由外键保证。

### 1.5 exp_events

```sql
CREATE TABLE exp_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      int         NOT NULL,
  reason     varchar(32) NOT NULL,
  ref        varchar(64) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_exp_events_delta_nonzero CHECK (delta <> 0),
  CONSTRAINT ck_exp_events_reason CHECK (reason IN ('manual','register','topic','reply','like','reward','import')),
  CONSTRAINT ck_exp_events_ref CHECK (ref = '' OR ref ~ '^[a-z_]+:[0-9]+$')
);

CREATE INDEX idx_exp_events_user ON exp_events (user_id, created_at DESC, id DESC);

-- 幂等键：同一次事件只记一笔经验（队列重试、并发重放都不重复加）
CREATE UNIQUE INDEX uq_exp_events_user_reason_ref ON exp_events (user_id, reason, ref)
  WHERE ref <> '';
```

`reason` 值域与 Go 常量 `title.Reason*` 同名（自检比对）。`ref` 的形状是 `<实体>:<内部id>`（`post:42` / `donation:7`），与静音 key 同一套编码、同一个 helper 生成。

### 1.6 public_id 的取舍

`notifications` / `messages` / `titles` **必须有** —— 它们的端点按 id 寻址（`DELETE /notifications/{id}`、`DELETE /messages/{id}`、`/admin/titles/{id}`），而 §2.3 禁止把自增 id 返给前端（盲审 M6 点名了 notifications）。

`notification_mutes` / `user_titles` / `exp_events` **不要**：前两张是对外行为的输入（用 kind + ref 表达），最后一张没有对外端点。少三列、少三个唯一索引。

### 1.7 与 ent 的关系（哪些必须留在手写迁移）

| 对象 | ent 能不能生成 | 落点 |
|---|---|---|
| 全部 CHECK | **不能**（`field.Enum` 在 PG 只落 varchar，数据库文档 §2.6 已核实） | 手写迁移；ent 侧写 `field.Enum(...).Values(...)` 让 Go 有类型 |
| `uq_notifications_user_dedup` / `uq_exp_events_user_reason_ref` | **不能**（部分唯一索引） | 手写迁移 |
| `idx_notifications_inbox` / `idx_notifications_unread` / `idx_messages_unread_*` | **不能**（部分索引） | 手写迁移 |
| `idx_users_nickname_lower`（§4.14） | **不能**（表达式索引） | 手写迁移 |
| `payload jsonb NOT NULL DEFAULT '{}'` | 能（`entsql.DefaultExpr("'{}'::jsonb")`） | ent schema |
| `public_id` 无默认值 | 能（不写 `Default`） | ent schema |
| `users` 的三列 + 全部普通索引/外键/删除动作 | 能 | ent schema |

> 【未决】Atlas diff 会想 DROP 手写对象（盲审 B6 已登记）。本域新增的手写对象请一并加进 B6 建议的「必需索引存在性」白名单断言，否则 CI 长期红或被人当噪声删掉。

---

## 2. ent schema 设计

路径（`forum/internal/ent/schema/`）：新增 `notify.go`、`notification_mute.go`、`message.go`、`title.go`、`user_title.go`、`exp_event.go`；**改** `user.go`（重新生成 ent 代码后随之更新）。

### 2.1 notify.go

```go
func (Notification) Fields() []ent.Field {
	return []ent.Field{
		field.UUID("public_id", uuid.UUID{}).Unique().Immutable(),
		field.Int64("user_id"),
		field.Int64("actor_id").Optional().Nillable(),
		field.Enum("type").Values("reply", "mention", "like", "reward", "review", "sanction", "system"),
		field.JSON("payload", map[string]any{}),
		field.String("link").Default(""),
		field.String("dedup_key").Default(""),
		field.Time("read_at").Optional().Nillable(),
		field.Time("deleted_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (Notification) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("user", User.Type).Ref("notifications").Field("user_id").Required().Unique(),
		edge.From("actor", User.Type).Ref("acted_notifications").Field("actor_id").Unique(),
	}
}

func (Notification) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "created_at", "id").Annotations(entsql.IndexWhere("deleted_at IS NULL")),
		index.Fields("user_id").Annotations(entsql.IndexWhere("read_at IS NULL AND deleted_at IS NULL")),
		index.Fields("actor_id"),
	}
}
```

`entsql.IndexWhere` 是冗余表达：DDL 以手写迁移为准，ent 侧写它只是让两边读起来一致。**若 Atlas diff 因此长期不等，删掉 ent 侧的 where 注解、只留手写迁移**（B6 的老问题，本域不自己发明新机制）。

`Edges()` 只服务后台一次性加载；**列表查询不走 ent 的 eager load**（§4.1 用原生 SQL，理由见那里）。

### 2.2 notification_mute.go

```go
func (NotificationMute) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("user_id"),
		field.Enum("type").Values("reply", "mention", "like", "reward", "review", "sanction", "system", "link"),
		field.String("target_key").Default(""),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (NotificationMute) Edges() []ent.Edge {
	return []ent.Edge{edge.From("user", User.Type).Ref("notification_mutes").Field("user_id").Required().Unique()}
}

// 复合业务主键在 ent 里退化成唯一索引；DDL 仍是 PRIMARY KEY (user_id, type, target_key)，不引入 id 列
func (NotificationMute) Indexes() []ent.Index {
	return []ent.Index{index.Fields("user_id", "type", "target_key").Unique()}
}
```

### 2.3 message.go

字段同 §1.3 顺序；`field.String("body").MaxLen(2000)` → `varchar(2000)`；`read_at` 是 `Optional().Nillable()`，两个删除位是 `Default(false)`。

`Indexes()`：`(low_id,high_id,id DESC)`、`(high_id,low_id,id DESC)`、两条带 `IndexWhere` 的部分索引、`(sender_id)`。

`Edges()`：`low` / `high` / `sender` 三条 `edge.From(...).Field(...)`，外键动作 CASCADE（`entsql.Annotation{OnDelete: entsql.Cascade}`）。

### 2.4 title.go / user_title.go / exp_event.go

- `title`：§1.4 的列；`Indexes()` 只有 `key` 唯一。**不给 `archived_at` 建索引**：目录几十行，不值得。
- `user_title`：`Indexes()` = `(user_id,title_id)` 唯一、`(title_id)`、`(granted_by)`。
- `exp_event`：`Indexes()` = `(user_id,created_at DESC,id DESC)`、`(user_id,reason,ref)` 唯一。

### 2.5 user.go 的改动

```go
field.Int64("equipped_title_id").Optional().Nillable(),
field.Int("exp").Default(0),
field.Int("level").Default(1),
// Indexes() 追加
index.Fields("equipped_title_id"),
// Edges() 追加两条反向边（持有的头衔经 user_titles、经验流水），
//   以及一条佩戴边 edge.To("equipped_title", Title.Type).Field("equipped_title_id").Unique()
```

**`equipped_title_id ∈ user_titles(user_id)` 数据库不做约束**（跨表 CHECK 做不到，触发器被 §2.12「不建触发器」禁掉）→ 靠 service 事务 + 一条自检 SQL（§9）。

---

## 3. Go 接口

### 3.1 internal/notify

```go
type Service struct{ /* db, dbRead, clock, queue, pg, users, settings */ }

func NewService(db, dbRead *ent.Client, clk clock.Clock, q queue.Queue,
	pg *pgsql.Queries, users UserLookup, settings NoticeSettings) *Service

// 同一事务内调用；幂等（§4.4）
func (s *Service) Create(ctx context.Context, tx *ent.Tx, in CreateInput) error

func (s *Service) List(ctx context.Context, actor *authz.Actor, in ListInput) (*ListResult, error)
func (s *Service) UnreadCount(ctx context.Context, actor *authz.Actor) (int, error)
func (s *Service) MarkRead(ctx context.Context, actor *authz.Actor, in MarkReadInput) (int, error)
func (s *Service) Delete(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) SetMute(ctx context.Context, actor *authz.Actor, in MuteInput) error
func (s *Service) UnsetMute(ctx context.Context, actor *authz.Actor, in MuteInput) error

type CreateInput struct {
	UserID  int64  // 收件人
	ActorID int64  // 触发者；系统通知为 0 → NULL
	Kind    string // KindReply | KindMention | KindLike | KindReward | KindReview | KindSanction | KindSystem
	RefType string // post | topic | comment | issue | donation | sanction | system
	RefID   int64  // 与 RefType 配对的内部 id；system 为 0
	TopicID int64  // 0 = 无；只用于拼 link 与渲染
	Link    string // 站内相对路径，'/' 开头
	Text    string // 仅 system
}
type ListInput struct {
	Kind       string // 对应 wire 面的 ?kind=
	UnreadOnly bool
	Cursor     string
	Limit      int
}
type MarkReadInput struct {
	PublicIDs []string
	All       bool
}
type MuteInput struct {
	Type    string // 类别，或 "link"
	RefType string // "" | "post" | "topic"
	RefID   int64
}

// 任务入口（payload 见 §5.1）；不开事务包业务，自己 WithTx
func (s *Service) NotifyReply(ctx context.Context, in CreateNotifyInput) error
func (s *Service) NotifyMention(ctx context.Context, in CreateNotifyInput) error
func (s *Service) NotifyLike(ctx context.Context, in CreateNotifyInput) error
func (s *Service) NotifyReward(ctx context.Context, in CreateNotifyInput) error

type CreateNotifyInput struct { // 任务 payload 的反序列化形状；NonZero 字段与 payload 键一一对应
	Kind    string
	ActorID int64
	RefType string
	RefID   int64
	TopicID int64
	UserID  int64 // 仅 mention 需要（被提及者）
}
```

`MarkRead` 的两个字段都空 → `apperr.Invalid`；**不**把空数组解释成「全部」。

**deps.go**

```go
type Queue interface{ EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error }

// 实现方：*user.Service
type UserLookup interface {
	GetBrief(ctx context.Context, userID int64) (*UserBrief, error)                // 不存在 → user.ErrNotFound
	GetBriefs(ctx context.Context, userIDs []int64) (map[int64]*UserBrief, error)  // 批量；空输入返回空 map
}
type UserBrief struct{ ID int64; Handle, Nickname, Avatar, AvatarSmall string }

// 实现方：*user.Service（读 user_notice_settings）
type NoticeSettings interface{ Get(ctx context.Context, userID int64) (*NoticeSetting, error) }
type NoticeSetting struct{ Alert bool; ReplyScope, MentionScope string; LikeAlert bool }
```

两个接口都在**使用方**（本包 deps.go）定义，app 层把 `*user.Service` 传进来（后端方案 §4.2 第 3 条）。`user` 包完全不需要知道 notify 存在。

### 3.2 internal/message

```go
func NewService(db, dbRead *ent.Client, clk clock.Clock, pg *pgsql.Queries,
	users UserLookup, blocks BlockReader) *Service

func (s *Service) ListConversations(ctx context.Context, actor *authz.Actor, in PageInput) (*ConversationPage, error)
func (s *Service) ListThread(ctx context.Context, actor *authz.Actor, in ThreadInput) (*ThreadPage, error)
func (s *Service) Send(ctx context.Context, actor *authz.Actor, in SendInput) (*MessageDTO, error)
func (s *Service) MarkThreadRead(ctx context.Context, actor *authz.Actor, peerHandle string) (int, error)
func (s *Service) DeleteMessage(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) UnreadTotal(ctx context.Context, actor *authz.Actor) (int, error)

type PageInput struct{ Cursor string; Limit int }
type ThreadInput struct {
	PeerHandle string
	Cursor     string
	Limit      int
}
type SendInput struct{ PeerHandle, Body string }

// deps.go
type UserLookup interface {
	ByUsername(ctx context.Context, username string) (*UserBrief, error) // 不存在 → user.ErrNotFound
	GetBrief(ctx context.Context, userID int64) (*UserBrief, error)
	GetBriefs(ctx context.Context, userIDs []int64) (map[int64]*UserBrief, error)
}
type UserBrief struct{ ID int64; Handle, Nickname, Avatar, AvatarSmall string }

// 实现方：*forum.Service（blocks 在 forum 的 schema 里）
type BlockReader interface {
	BlockedBetween(ctx context.Context, a, b int64) (aBlockedB, bBlockedA bool, err error)
}
```

### 3.3 internal/title

```go
func NewService(db, dbRead *ent.Client, clk clock.Clock, audit AuditSink) *Service

func (s *Service) ListTitles(ctx context.Context) ([]TitleDTO, error)
func (s *Service) UserTitles(ctx context.Context, userID int64) (*UserTitlesDTO, error)
func (s *Service) Equip(ctx context.Context, actor *authz.Actor, titlePublicID string) error // "" = 取消佩戴
func (s *Service) AssignTitle(ctx context.Context, actor *authz.Actor, in AssignInput) error
func (s *Service) CreateTitle(ctx context.Context, actor *authz.Actor, in TitleInput) (*TitleDTO, error)
func (s *Service) UpdateTitle(ctx context.Context, actor *authz.Actor, in TitleInput) (*TitleDTO, error)
func (s *Service) AddExp(ctx context.Context, actor *authz.Actor, in AddExpInput) (*ExpDTO, error) // 调用点未决，见 §6.4

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

// deps.go
type AuditSink interface{ Log(ctx context.Context, e audit.Entry) error }
```

### 3.4 Handler 路由注册

```go
// internal/notify/handler.go
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc) {
	g := rg.Group("/notifications", requireLogin)
	g.GET("", h.list)
	g.GET("/unread-count", h.unreadCount)
	g.POST("/read", h.markRead)
	g.DELETE("/:id", h.remove)
	g.PUT("/mutes", h.setMute)
	g.DELETE("/mutes", h.unsetMute) // §11 U1：§21.2 缺取消静音
}

// internal/message/handler.go
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc) {
	g := rg.Group("/messages", requireLogin)
	g.GET("", h.listConversations)
	g.GET("/unread-count", h.unreadTotal) // §11 U2：顶栏角标
	g.GET("/:handle", h.listThread)
	g.POST("/:handle", h.send)
	g.POST("/:handle/read", h.markRead)
	g.DELETE("/:id", h.remove)
}

// internal/title/handler.go
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin, perm gin.HandlerFunc) {
	rg.GET("/titles", h.listTitles)
	rg.GET("/users/:handle/titles", h.userTitles)
	rg.PUT("/me/title", requireLogin, h.equip)
	a := rg.Group("/admin", requireLogin)
	a.POST("/users/:id/titles/:titleId", perm(authz.PermTitleGrant), h.grant)
	a.DELETE("/users/:id/titles/:titleId", perm(authz.PermTitleGrant), h.revoke)
	a.GET("/titles", perm(authz.PermTitleManage), h.adminList)
	a.POST("/titles", perm(authz.PermTitleManage), h.adminCreate)
	a.PATCH("/titles/:id", perm(authz.PermTitleManage), h.adminUpdate)
}

// internal/user/handler.go（本域只加这一条路由，不动 user 其它逻辑）
rg.GET("/users/search", h.searchUsers) // 游客可访问
```

**admin 端点的 `{id}` 是什么**：§21.1 规定「ID 一律是 public_id」，所以 `/admin/users/{id}/titles/{titleId}` 与 `/admin/titles/{id}` 里两个都是 public_id（用户、头衔各一个）。**不要**在这两个路径里用 handle —— 与 `/users/{handle}` 是两套寻址。

### 3.5 users/search 的 DTO（实现归 user 模块，SQL 与索引由本文交付）

```go
func (s *Service) Search(ctx context.Context, actor *authz.Actor, in SearchUsersInput) ([]UserSearchDTO, error)
type SearchUsersInput struct{ Q string; Limit int } // Limit 默认 8、上限 20
type UserSearchDTO struct {
	PublicID, Handle, Nickname, Avatar, AvatarSmall string
	Dup                                             bool
}
```

`Dup` 的语义是**该昵称在整个 users 表里不止一个人用**，不是「在本次结果里重复」——理由见 §4.14。

---

## 4. 非平凡 SQL

> 原生 SQL 只允许在 `platform/search/pgsql` 与手写迁移里（开发必读 §1 第 8 条）。本域的非平凡查询全部收进 `internal/platform/search/pgsql/social.sql`（一个文件按域分组），ent 能表达的（按 id/public_id 查一行、按 user_id 软删、批量 upsert）一律用 ent 写。

### 4.1 通知列表（游标分页 + actor 现取昵称/头像 + 我的拉黑关系）

```sql
SELECT n.public_id, n.type, n.payload, n.link, n.read_at, n.created_at,
       a.public_id AS actor_public_id, a.username AS actor_handle, a.nickname AS actor_nickname,
       a.avatar_hash, a.avatar_small_hash,
       EXISTS (SELECT 1 FROM blocks b
                WHERE b.user_id = n.actor_id AND b.target_user_id = n.user_id) AS actor_blocked
  FROM notifications n
  LEFT JOIN users a ON a.id = n.actor_id
 WHERE n.user_id = $1
   AND n.deleted_at IS NULL
   AND ($2::timestamptz IS NULL OR (n.created_at, n.id) < ($2::timestamptz, $3::bigint))
   AND ($4::text = '' OR n.type = $4)
 ORDER BY n.created_at DESC, n.id DESC
 LIMIT $5;
```

- **索引**：`idx_notifications_inbox (user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL`。首页（不传游标）时 `$2 IS NULL` 让整个游标条件短路。
- **EXPLAIN 预期**（10 万行通知、单用户 2000 条、`LIMIT 20`）：`Index Scan Backward using idx_notifications_inbox on notifications n`，`Index Cond: ((user_id = $1) AND (ROW(created_at, id) < ROW($2, $3)))`；`Index Scan using users_pkey on users a`（1 行）；`SubPlan` 走 `blocks_pkey`（1 行）。**不得出现 `Seq Scan on notifications`**。
- 带 `kind` 且该类别稀疏（例如全站只有 3 条 `review`）时，`rows removed by filter` 可能上千。**阈值写在这里**：若 EXPLAIN 显示 removed > 5000，再加 `(user_id, type, created_at DESC, id DESC) WHERE deleted_at IS NULL`（不预建，见 §11 U3）。
- **游标**：`cursor = base64url(JSON{"k":<created_at RFC3339Nano>,"id":<bigint>})`；`id` 用**内部 id**（不出现在响应里，只做并列兜底）。取不满 20 行则 `next_cursor = null`。
- **为什么这条用原生 SQL 而不是 ent**：`LEFT JOIN users` 现取 actor 昵称、`EXISTS(blocks)` 表达「我拉黑了这个人」、行序比较游标——三样拼起来用 ent 要手写 `Modify`（等于写 SQL），可读性更差。**这是它进 `pgsql` 的唯一理由**；单条读、写、软删全走 ent。

### 4.2 未读数（必须走部分索引，不许 COUNT(*) 全表）

```sql
SELECT count(*) FROM notifications
 WHERE user_id = $1 AND read_at IS NULL AND deleted_at IS NULL;
```

- **索引**：`idx_notifications_unread (user_id) WHERE read_at IS NULL AND deleted_at IS NULL`。
- **EXPLAIN 预期**：`Aggregate → Index Only Scan using idx_notifications_unread`，`Index Cond: (user_id = $1)`；未读 0 条时读 1 行、30 条时读 30 行。**出现任何 `Seq Scan` 即为实现错误**——谓词与索引谓词只要字面量不同就会这样，所以 `read_at IS NULL` 必须逐字一致。
- 该查询**不**JOIN，也**不**带 `type` 过滤：角标是「全部未读」。

### 4.3 批量已读

```sql
UPDATE notifications SET read_at = now()
 WHERE user_id = $1 AND read_at IS NULL
   AND ( $2::bool OR public_id = ANY($3::uuid[]) );
```

- **索引**：`idx_notifications_unread` 定位待改行。
- **并发重放**：`read_at IS NULL` 使第二次执行改 0 行；两个标签页同时点「全部已读」→ 第二个 0 行。**返回受影响行数**（「本次新标记了几条」），前端不拿它当状态（状态以重新拉取的列表为准）。
- 锁是行级；一次最多改该用户的未读行数（常见 < 100）。`all=false` 且 `ids` 为空 → `apperr.Invalid`。

### 4.4 通知写入（幂等 upsert）

```sql
INSERT INTO notifications (public_id, user_id, actor_id, type, payload, link, dedup_key)
VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
ON CONFLICT (user_id, dedup_key) WHERE dedup_key <> '' DO NOTHING;
```

- **索引**：`uq_notifications_user_dedup`。
- **并发下会发生什么**：两个任务同时投同一事件 → 一个 INSERT 成功、另一个 `DO NOTHING` 返回 0 行，**两个事务都不报错**。这是选 `DO NOTHING` 而不是「捕获 23505 再吞掉」的原因：并发下捕获唯一冲突会留下失败的事务状态，还要在原地写重试。
- **dedup_key 的取值（幂等键的唯一来源）**：

| kind | dedup_key | 说明 |
|---|---|---|
| reply | `reply:post:<post_id>` | post_id 是被回复的那条楼层 |
| mention | `mention:<ref_type>:<ref_id>` | 被提及的那条正文所在的实体（`mention:post:42` / `mention:comment:88`）；同一处提两次同一人只一条 |
| like | `like:post:<post_id>` | 取消赞再加同一帖仍是同一 key |
| reward | `reward:donation:<donation_id>` | 打赏单 id |
| review | `review:topic:<topic_id>` | 重审同帖只一条 |
| sanction | `sanction:sanction:<sanction_id>` | 处罚 id |

`payload` 里的 id 与 dedup_key 的 id **必须同源**（同一个入参），否则「重试不重复」与「点进去看的是哪条」会指向不同东西。

### 4.5 静音匹配（生成通知前的唯一一次判定）

```sql
SELECT 1 FROM notification_mutes
 WHERE user_id = $1
   AND ( (type = $2 AND target_key = '')        -- $2 = 通知类别
      OR (type = 'link' AND target_key = $3) )  -- $3 = RefKey(通知的 ref_type, ref_id)
 LIMIT 1;
```

- **索引**：主键 `(user_id, type, target_key)`。谓词里三列都是主键列 → `BitmapOr` 下两段 `Bitmap Index Scan on notification_mutes_pkey`，`rows = 0..2`。
- 数据量天然极小（一人几行），SEQ SCAN 也无所谓，但索引必须在。
- 命中即**不插入任何行**（连软删的行都不建）：「不再通知」在语义上不该留痕迹。**代价**：取消静音后看不到期间错过的通知（这是「静音」与「延迟」的区别，写在这里当口径）。

### 4.6 会话列表：对方 + 最后一条 + 未读数，**一条 SQL**

```sql
WITH conv AS (
    SELECT peer, id FROM (
        SELECT high_id AS peer, id FROM messages WHERE low_id  = $1
        UNION ALL
        SELECT low_id  AS peer, id FROM messages WHERE high_id = $1
    ) c1
     GROUP BY peer
),
last_msg AS (
    SELECT DISTINCT ON (peer) peer, id AS last_id
      FROM conv ORDER BY peer, id DESC
),
unread AS (
    SELECT sender_id AS peer, count(*) AS n FROM messages
     WHERE low_id = $1 AND read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id
     GROUP BY sender_id
    UNION ALL
    SELECT sender_id AS peer, count(*) AS n FROM messages
     WHERE high_id = $1 AND read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id
     GROUP BY sender_id
)
SELECT l.peer, COALESCE(ux.n, 0) AS unread_count,
       m.public_id AS last_public_id, m.body, m.sender_id, m.read_at, m.created_at,
       (m.sender_id = $1) AS last_is_mine
  FROM last_msg l
  JOIN users    u ON u.id = l.peer AND u.status <> 'deleted'
  JOIN messages m ON m.id = l.last_id
  LEFT JOIN (SELECT peer, sum(n) AS n FROM unread GROUP BY peer) ux ON ux.peer = l.peer
 WHERE ($2::bigint = 0 OR l.last_id < $2)
 ORDER BY m.id DESC
 LIMIT $3;
```

- **索引与三个子计划**：
  - `conv` 的两支各命中 **`idx_messages_pair_low (low_id,high_id,id DESC)`** 与 **`idx_messages_pair_high (high_id,low_id,id DESC)`**。`UNION ALL` 把 `OR` 拆成两个独立索引扫描；写成 `WHERE low_id=$1 OR high_id=$1` 会退化成一次 `BitmapOr`，行数上万后明显更慢。
  - **为什么没有 Sort（这是「一条 SQL 出」成立的关键）**：
    1. `conv` 的两支各自 `Index Scan` 就能吐出 `(peer, id DESC)`；`UNION ALL` 后是 `Append`，输入天然有序；
    2. `GROUP BY peer` 因此走 **GroupAggregate**（对有序输入做分组），不是 HashAggregate —— 输出仍按 `peer` 有序；
    3. `DISTINCT ON (peer) … ORDER BY peer, id DESC` 在有序输入上退化成 **Unique** 节点，**代价是一次索引扫描到底**，没有排序；
    4. 最终 `ORDER BY m.id DESC` 只排「我的会话数」行（几百），内存排序。
    **EXPLAIN 里不该出现 `Sort Method: external merge`，也不该出现对 `conv` 的 `Seq Scan`**。
  - `unread` 两支各命中 **`idx_messages_unread_low` / `idx_messages_unread_high`**（谓词逐字一致），聚合后 `sum` 合并。
  - 外层 `ORDER BY m.id DESC LIMIT 20` 排的是「我的会话数」量级（几百行），内存排序，接受。**判据**：EXPLAIN 里对 `messages` 的两个 `Index Scan` 的 `rows` 应约等于我的会话数；若某一支达到我的消息总量（例如 5 万），说明索引顺序写错了（例如建成 `(low_id, id DESC, high_id)`）。
- **游标**：`cursor = base64url(JSON{"id":<last_id>})`；`$2` 那段必须加在 `last_msg` 里（照上面的写法），**不能只加在最外层**——那样每一页都要先算完所有会话的 last_id。
  代价：「本页最后一行的 last_id 之后还有没有下一个会话」这个判断失效——翻页深度由 `last_id` 的**值**保证（它是最大消息 id，单调），所以不会漏项、不会重项。
- **「各自删除」不进这个查询**：我删掉的那条仍要显示给对方，所以按会话聚合、不按消息可见性过滤。**明确取舍**：可能出现「列表里有最后一条、点进去是空的」，接受（换来 0 次额外扫描）。
- 会话数少（1 个）时是同一计划。
- **「一条 SQL 出」指什么**：一次往返拿到「对方 + 最后一条 + 未读数」三样。为此付的代价是 `conv` **两支各自扫到会话末尾**（用 `(low_id,high_id,id DESC)` 的索引有序性换掉一次 `DISTINCT ON` 排序）。会话数多、每会话消息多时，这是本域最贵的查询——所以它上面挂着 30 秒轮询的替代方案（§4.15 的 unread-count）。
- **替代写法（会话数超过几千时再考虑，现在不做）**：在 `messages` 上维护 `conversations` 摘要表（对方、最后一条、未读计数），把这条查询降成一次主键读。代价是多一张表 + 每次发消息要更新它（写放大 + 漂移风险），现在没有这个量级的需求。

### 4.7 会话内消息（游标翻页）

```sql
-- me < peer 时
SELECT public_id, sender_id, body, read_at, created_at
  FROM messages
 WHERE low_id = $1 AND high_id = $2
   AND deleted_by_low = false
   AND ($3::bigint = 0 OR id < $3)
 ORDER BY id DESC
 LIMIT $4;
-- me > peer 时：low_id/high_id 互换，deleted_by_low → deleted_by_high
```

- **索引**：`idx_messages_pair_low`（`me<peer`）或 `idx_messages_pair_high`（`me>peer`）。
- **在 Go 里按 `me < peer` 二选一，不要留 `OR` 让优化器猜**——两条 SQL 的谓词各自与一个索引完全对齐。我先规范化成 `(low,high)` 再拼这句，所以永远只有一支可能为真。

### 4.8 未读角标（顶栏，30 秒轮询）

```sql
SELECT count(*) FROM messages
 WHERE low_id = $1 AND read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id
UNION ALL
SELECT count(*) FROM messages
 WHERE high_id = $1 AND read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id;
```

Go 侧把两行相加。**索引**：两个未读部分索引各一段 `Index Only Scan`，`rows` = 我的未读总数。

**为什么用 `UNION ALL` 而不是一个 `OR`**：`OR` 会让优化器在「BitmapOr 两个部分索引」与「全表扫」之间选，数据倾斜时后者可能赢；拆成两支后每条都能各自走部分索引，计划确定。

§4.8 的结果必须等于 §4.6 里 `unread_count` 之和（同一批谓词、同两张索引）——这是一条便宜的测试断言。

### 4.9 拉黑判定（发私信前）

```sql
SELECT 1 FROM blocks
 WHERE (user_id = $1 AND target_user_id = $2)
    OR (user_id = $2 AND target_user_id = $1)
 LIMIT 1;
```

`blocks` 主键 `(user_id, target_user_id)` + `idx_blocks_target (target_user_id)` → 两支各一段 Index Scan，`rows ≤ 1`。

### 4.10 发送私信

```sql
INSERT INTO messages (public_id, low_id, high_id, sender_id, body)
VALUES ($1, LEAST($2,$3), GREATEST($2,$3), $2, $4)
RETURNING id, public_id, created_at;
```

**并发下会发生什么**：同一个人连点两次「发送」→ 两条不同的消息。私信重复内容是正常对话，**不做** `client_token` 幂等键（§21.1 的可选幂等只提了发帖与回复）。

### 4.11 批量已读某会话

```sql
UPDATE messages SET read_at = now()
 WHERE low_id = $1 AND high_id = $2 AND sender_id = $2
   AND read_at IS NULL AND deleted_by_low = false;
-- me > peer 时：high_id/low_id 互换，deleted_by_low → deleted_by_high
```

- **索引**：`idx_messages_unread_low` / `_high`（`sender_id = high_id` 与索引里的 `sender_id <> low_id` 在 `low_id < high_id` 下等价）。
- 并发：两个设备同时打开会话 → 第二个改 0 行。返回受影响行数。

### 4.12 佩戴头衔

```sql
-- ① 必须是我持有的、未归档的头衔
SELECT t.id FROM user_titles ut
  JOIN titles t ON t.id = ut.title_id
 WHERE ut.user_id = $1 AND t.public_id = $2 AND t.archived_at IS NULL;

-- ② 佩戴（唯一性由 users 的一个可空外键天然保证）
UPDATE users SET equipped_title_id = $2, updated_at = now() WHERE id = $1;
```

**并发重放**：并发两次佩戴 → 后写覆盖，绝不会出现「戴两个」；重复佩戴同一个 → 同值 UPDATE，幂等。
① 索引：`user_titles_pkey (user_id,title_id)` 一段 Index Scan（`rows ≤ 头衔数`）+ `titles_pkey` 回表。

### 4.13 经验与等级：一次 UPDATE，不变量在同一句里

```sql
UPDATE users
   SET exp   = exp + $2,
       level = floor(sqrt((exp + $2) / 100.0))::int + 1,
       updated_at = now()
 WHERE id = $1
RETURNING exp, level;
```

- `exp` 是 `int`，`sqrt` 要 `numeric`：写 `(exp + $2) / 100.0`（PG 里 `int / numeric → numeric`，不截断）。取整固定为**向下**，与 Go 的 `int(math.Floor(math.Sqrt(float64(e)/100)))+1` 一致；**Go 侧也要有同一个函数**并在写 `users.level` 时用它，两处算法逐字相同（自检覆盖）。
- **并发安全**：`exp + $2` 是读-改-写在同一句里，PG 行锁保证不丢更新。**不需要** `SELECT ... FOR UPDATE`。这一点很重要：`users` 是**全站写热点行**，任何「先查再加再写」的写法都会在热门作者那一行上排队。
- **顺序**：同一事务里先 `INSERT INTO exp_events ... ON CONFLICT DO NOTHING` 并看 `RETURNING id` 是否真的插入了；**只有插入了才执行上面的 UPDATE**。否则重试会把经验加两次。

### 4.14 用户搜索（`GET /api/v1/users/search?q=`）——UNION ALL，不用 OR

```sql
WITH c AS (
    SELECT DISTINCT ON (u.id)
           u.id, u.public_id, u.username, u.nickname, u.avatar_hash, u.avatar_small_hash, u.src
      FROM (
        SELECT u.id, u.public_id, u.username, u.nickname, u.avatar_hash, u.avatar_small_hash, 0 AS src
          FROM users u
         WHERE u.status <> 'deleted' AND lower(u.username) LIKE $1
        UNION ALL
        SELECT u.id, u.public_id, u.username, u.nickname, u.avatar_hash, u.avatar_small_hash, 1 AS src
          FROM users u
         WHERE u.status <> 'deleted' AND lower(u.nickname) LIKE $1
         LIMIT 40
      ) u
     ORDER BY u.id, u.src
)
SELECT c.public_id, c.username, c.nickname, c.avatar_hash, c.avatar_small_hash,
       (SELECT count(*) FROM users d WHERE lower(d.nickname) = lower(c.nickname)) > 1 AS dup
  FROM c
 ORDER BY c.src, c.nickname, c.id
 LIMIT $2;   -- $2 = limit，默认 8、上限 20
```

- **索引**：`uq_users_username_lower (lower(username))`（已存在）+ **新增** `idx_users_nickname_lower (lower(nickname))`。两条 `LIKE 'x%'` 是 left-anchored 前缀匹配，各自走 B-tree 范围扫描（唯一索引也是 B-tree，同样能服务前缀扫描）。
- **为什么 UNION ALL 而不是 `OR`**：单条 `WHERE lower(username) LIKE $1 OR lower(nickname) LIKE $1` 是两个不同列上的 OR，PG 只能 `BitmapOr`，或在代价估计偏向顺序读时直接 **Seq Scan + Sort**——一旦 seq scan，每次自动补全就是一次全表扫，而这个端点**每个人打字都在调**。拆成两支后每支都是确定的索引范围扫描，且各带 `LIMIT`。
- **代价**：同一个人可能两行都命中（登录名与昵称都匹配）。`DISTINCT ON (u.id) … ORDER BY u.id, u.src` 按 `src` 取小者去重，于是「登录名命中」排在前面。内层 `LIMIT 40` 是给「昵称路命中太多」兜底。
- **`dup` 的含义**：`lower(nickname)` 的持有者总数 > 1。**不用「本次结果里重复」**——结果只有 8 条，另一个同名的人可能根本不在结果里，那样界面不会标记，用户就会 @ 错人，而 @ 错不可撤销（对方已经收到通知）。这个子查询是等值查找，走 `idx_users_nickname_lower`，每次一段 Index Scan（`rows` = 同名人数，通常 1–2）。
- **EXPLAIN 预期**（10 万用户、`q` 长度 ≥ 2）：`Append` 下两个 `Index Scan`（`uq_users_username_lower` / `idx_users_nickname_lower`），各 `rows` ≈ 前缀命中数（个位到几十）；两个 `SubPlan` 各走一次 `idx_users_nickname_lower` 等值。**不得出现 `Seq Scan on users`**。
- **输入约束（信任边界，只在 HTTP 入参上做）**：`len(q) < 2` → 直接返回空数组（不查库、不报错）；`q` 上限 32 字符；`%` / `_` / 反斜杠必须转义（`escapeLike`），否则 `%` 会变成「匹配所有人」。

### 4.15 未读角标的另一条路（被否掉）

顶栏角标可以不新增端点，直接复用 `GET /messages`（会话列表）把 `unread_count` 求和。**否掉的理由**：30 秒一次 × 每个在线用户，每次都要算完整会话列表（§4.6 是这条设计里最贵的查询），而用户只想要一个数字；§4.8 只要两次 index-only count。**所以加 `GET /messages/unread-count`**，写进 §11 U2。

---

## 5. 业务规则

### 5.1 通知产生路径（全部走任务）

```text
① 回复  forum.POST /topics/{id}/posts
   事务内：插 posts → 改主题/楼层计数 → EnqueueTx(notify:reply,
        {ref_type:"post", ref_id:post_id, topic_id, actor_id})
   任务：收件人 = 楼层作者 + 主题作者（去重后 ≤ 2 人）→ Create（幂等）

② @提及  同①的事务：forum 先 mention.Parse(content_md) 拿到去重后的 [user_id...]
   → 对每个被提及者 EnqueueTx(notify:mention,
        {ref_type:"post", ref_id:post_id, topic_id, mention_user_id})
   任务：NotifyMention → Create
   （issue 评论同理，只是 ref_type="comment"、ref_id=评论 id；
     提及只有这两个来源——帖子正文即 1 楼，也是 post）

③ 点赞  forum.PUT /posts/{id}/vote（value=1，且本次是新投或由 -1 改 1）
   事务内：upsert likes、改计数 → EnqueueTx(notify:like,
        {ref_type:"post", ref_id:post_id, topic_id, actor_id})
   任务：NotifyLike → 只有 value=1 才发；点踩不入队

④ 打赏到账  reward 核验事务（approved）→ EnqueueTx(notify:reward,
        {ref_type:"donation", ref_id:donation_id, actor_id:donor_id})
   任务：NotifyReward → 查 donation_records(state='approved') 拿 recipient/donor/amount → Create

⑤ 审核结果  forum 审核事务（approve/reject）→ EnqueueTx(notify:review,
        {ref_type:"topic", ref_id:topic_id, actor_id:0})   // 状态从 topics.review_state 现读
⑥ 处罚      admin 禁言事务 → EnqueueTx(notify:sanction,
        {ref_type:"sanction", ref_id:sanction_id, actor_id})
```

**共同的三条硬规则**：

1. **同一个事务里 EnqueueTx**（拍板 §5.4）：回滚了就没有通知，任务与业务数据同生共死。
2. **payload 只放 id**（拍板 §5.7）：全是 bigint，不放昵称快照。
3. **幂等靠 `dedup_key`**（§4.4）：payload 只用于算出 dedup_key（`RefKey(ref_type, ref_id)`），重试两次 → 第二个 `DO NOTHING`。

**谁不发通知**（在任务里判，判完 `return nil`）：

| 情形 | 判定 |
|---|---|
| 自己回复自己 / 自己赞自己 / 自己提自己 | `actor_id == user_id` |
| 回复主题作者时又 @ 了同一个作者 | 同一任务内按 `user_id` 去重，**只发 reply 一条**（reply 优先） |
| 收件人已静音该类别或该内容 | §4.5（匹配 key 由通知自己的 `ref_type`+`ref_id` 决定） |
| `reply_scope='none'` / `mention_scope='none'` | 不发对应那条 |
| 收件人不存在 / `status='banned'` | 不发（banned 登不进来，通知只增负担） |
| actor 是 `status='deleted'` 的用户 | 照发，渲染时显示「已注销」（`LEFT JOIN` 得到 NULL） |

**回复的通知对象钉死**：`topics.author_id` 与 `posts.parent_id` 的楼层作者，二者去重。楼中楼再往上不追（`parent_id` 只允许一级）。
**点赞的通知对象钉死**：被赞楼层的 `posts.author_id`；`likes.target_type='topic'` 时是 `topics.author_id`（同一套规则、同一张表）。

**失败怎么恢复**：任务队列自己退避重试（10s×2^attempts，上限 1 小时，默认 5 次），`ErrSkipRetry` 直接 dead。任务失败**不阻塞业务**——回复已经发出去，通知会晚到或漏掉。**明确不做补偿扫描**：收益是极少数晚到的通知，代价是一套「按事件重放通知」的对账逻辑。运维靠 dead 队列计数（诊断面板显示）。

### 5.2 私信规则

`Send` 的判定顺序（先做便宜的）：

```text
1. 登录（中间件）+ 邮箱已验证；未验证 → 403 auth.email_unverified
2. peer := users.ByUsername(handle)；不存在 → 404 common.not_found
3. peer.ID == actor.UserID → 400 common.invalid_input
4. blocks 任一方向命中 → 403 message.blocked（不说谁拉黑了谁）
5. body：trim 后非空、按 rune 数 ≤ 2000
6. INSERT messages（§4.10）
```

- **拉黑后既有会话还在**：不删历史，只是发不出去。「被拉黑发不出去」与「我拉黑了别人还看得见聊天记录」是两件事。
- **`DeleteMessage`**：只能删自己参与的（`actor ∈ {low,high}`），置对应布尔列；不判是否已读。删除后再 `MarkThreadRead` 不计入未读（部分索引有 `deleted_by_*` 谓词）。
- **`ListThread` 的可见性**：我删掉的不返回；对方删掉的不影响我。**两种删除的语义差异要在 DTO 里体现**——我删了 → 列表里不出现；对方删了 → 我照常看得见。
- **DTO 形状**（`GET /api/v1/messages/{handle}`）：
  `{ data: [{ id, body, mine: bool, read: bool, created_at }], next_cursor, peer: { handle, nickname, avatar, avatar_small } }`
- **轮询**：会话内 5 秒；未读角标 30 秒。**不做 SSE 的理由**：拍板 §6「明确不做」表 + 后端方案 §20.3（实时通道把内存预算绑在 2GB 机器上，收益不值）。服务端不为轮询做特殊优化：两个接口都是走索引的单次查询，5 秒 × 在线人数在 2 核上可控。

### 5.3 头衔规则

| 动作 | 权限点 | 规则 |
|---|---|---|
| 看目录 | 无 | 不返回 `archived_at IS NOT NULL` 的 |
| 看某人持有 | 无 | 返回全部持有（含归档的徽章）+ 当前佩戴 |
| 佩戴 / 取消 | 登录 | 只能戴自己持有且未归档的（§4.12①）；`title_id: null` → 取消 |
| 授予 | `title.grant` | 已持有 → **幂等成功**（不报 409） |
| 收回 | `title.grant` | 删 `user_titles` 行；**若正是佩戴项，同一事务把 `equipped_title_id` 清空** |
| 目录维护 | `title.manage` | 建 / 改（name/color/description）；**归档而非删除**；`key` 不可改（改 key 等于换一个头衔） |

- **收回与清佩戴必须同事务**，否则会出现「戴着已收回的头衔」（旧站手工做这件事，我们靠事务 + 自检 §9）。
- **归档不撤销已授予的**：`archived_at` 只影响目录可见与能否新佩戴。
- **头衔不参与授权**（数据库设计 §4.11、RBAC §7 都写明）：任何地方都不许拿头衔判权限。

### 5.4 等级与经验

- 等级是 `exp` 的**派生冗余列**，唯一写路径是 §4.13 那一句 UPDATE。
- **谁写 exp**：见 §6.4（未决）。当前只暴露 `AddExp`（内部 / CLI）。
- **一致性**：`users.exp = COALESCE(SUM(exp_events.delta),0)`，自检 §9。迁移导入必须同时写两边（旧站 `exp` 原值搬 + 一条 `reason='import'`、`ref='user:<old_id>'` 的流水）。
- 不设等级封顶（与旧站一致）。

### 5.5 清理（cron 的两条硬删）

```sql
-- 每天一次，分批 5000（长事务会挡 autovacuum、占连接池；池只有 16 条）
DELETE FROM notifications WHERE id IN (
  SELECT id FROM notifications WHERE deleted_at < now() - interval '90 days' LIMIT 5000);

DELETE FROM messages WHERE id IN (
  SELECT id FROM messages
   WHERE deleted_by_low AND deleted_by_high AND created_at < now() - interval '90 days' LIMIT 5000);
```

私信清理只删「双方都删」的行——任何一方还想看就不许硬删。**不做也能跑**，但通知表的部分索引会积累死元组，未读 COUNT 会慢慢变慢，所以要做。

### 5.6 @提及的解析与渲染（平台包）

新包 `internal/platform/mention`（平台层，不含业务；被 forum 与 search 用）：

```go
// Markdown 中的提及：[@昵称](mention:123)
var Re = regexp.MustCompile("\[@([^\]\n]{1,20})\]\(mention:(\d{1,18})\)")

type Mention struct {
	UserID   int64
	Nickname string // 写入时的快照
}

const MaxPerBody = 20

func Parse(md string) []Mention     // 按出现顺序、按 UserID 去重；不查库
func CheckLimit(ms []Mention) error // > 20 → 400 content.bad_mention
func Rewrite(html string, names map[int64]string) string
// names[id] 空 → 用链接文本里的昵称快照兜底；两者都空 → 去掉 <a>，留纯文本
```

- **解析在写入时做**（存 `content_md` 的同一个请求里），不在渲染时做：渲染时再解析，用户已经收到通知了，改不动。
- **id 校验**：forum 在事务外先批量查一次（`user.GetBriefs`），不存在或 `status='banned'` → 400 `content.bad_mention`。**校验在信任边界（HTTP 入参）上做，一次批量查询**，不是每个提及一次。
- **渲染**：服务端把 `mention:<id>` 改写为 `<a href="/u/<id>" data-mention="<id>">@<当前昵称></a>`，显示用当前昵称。**顺序是 goldmark → Rewrite → bluemonday**（见 §11 U7）。
- **通知**：每个被提及者一条 `mention` 通知；自己提自己不通知。「提及 + 回复同一人」去重见 §5.1。

---

## 6. 幂等 / 并发 / 失败恢复

### 6.1 并发重放会发生什么

| 场景 | 结果 |
|---|---|
| 双击「发送私信」 | 两条消息（不去重）。产品上正常 |
| 双击「标为已读」 | 第二次改 0 行，返回 0 |
| 两个管理员同时核验同一打赏单 | 打赏域的问题（`reward.already_handled`）；notify 侧只有一个 `EnqueueTx` 提交成功 → 一条通知 |
| `notify:reply` 任务重试两次 | 同一 dedup_key → 第二条 0 行、无错误 |
| 两个 worker 同时处理同一任务 | 同上，唯一索引兜住 |
| 取消赞再加赞 | 同一 `like:<post_id>` → 不再发第二条 |
| 两个管理员同时授予同一头衔 | 两边都成功（幂等），`user_titles` 一行 |
| 两个管理员同时收回同一头衔 | 第二个删 0 行、不报错；两边都清 `equipped_title_id` → 幂等 |
| A 佩戴 T1、另一标签页佩戴 T2 | 后写覆盖，最终只有一个 |
| 同一事件两次 `AddExp` | 第二次 `ON CONFLICT DO NOTHING` 返回 0 行 → 不加经验 |
| 我把某人拉黑，同时对方正在发消息 | 检查与 INSERT 之间有窗口 → 可能进来一条。**接受**（拉黑是社交边界，不是安全边界）。要不接受就得在 INSERT 前对 `blocks` 加锁，会引入跨模块锁顺序问题 |

### 6.2 失败之后数据停在哪

| 失败点 | 数据状态 | 要人手修吗 |
|---|---|---|
| `notify:*` 任务 DB 抖动 | 通知没生成，退避重试；> 5 次进 dead | 不用。dead 计数在诊断面板可见，**没有补偿扫描**（明确不做） |
| 通知写入成功但事务回滚 | 通知也不存在（同事务） | 不用 |
| 私信 INSERT 成功但响应超时 | 消息已在；用户重发得到两条 | 不用（不做幂等键） |
| `AddExp` 第二句 UPDATE 失败 | 不可能：两句同一事务 | — |
| 授予头衔成功、清佩戴失败 | 不可能：同一事务 | — |
| 归档一个正在佩戴的头衔 | 佩戴保留（规则允许） | 不用 |

### 6.3 这段代码不写会少什么

| 片段 | 不写会少什么 |
|---|---|
| `uq_notifications_user_dedup` | 「任务重试不重复生成通知」——M6 验收项直接不成立 |
| 未读谓词里的 `sender_id <> low_id` | 自己的未读角标把自己发的消息算进去（盲审 B3），角标永不为 0 |
| `idx_messages_pair_high` | 我是 high 一侧时会话列表全表扫（30 秒轮询的热路径） |
| `idx_messages_sender` | 外键索引自检红；删用户时全表扫 messages |
| `idx_users_equipped_title` | 外键索引自检红（盲审 B2 点名漏过它） |
| `AddExp` 里「先插流水再更新 exp」的顺序 | 重试会重复加经验 |
| §5.1 的 `actor_id == user_id` 判定 | 自己回复自己会收到通知 |
| §4.14 的 escapeLike | 输入 `%` 变成全表前缀匹配 |
| §5.5 的分批 DELETE | 单条大 DELETE 长时间持锁 + 巨量 WAL |

以上每条都留，没有「删掉也行」的。**反过来被删掉的**：通知聚合行、会话表、私信 `client_token`、通知邮件、通知的「已删可恢复」、exp 自动发放——都在 §0 的不做清单里。

### 6.4 exp 的发放规则（未决，见 §11 U5）

代码写好了「怎么加」，**没写「什么时候加」**——旧站 `award_exp` 的调用点未接（功能清单 5.4 写着「规则未接」）。三档代价：

| 选择 | 代价 |
|---|---|
| A 只管理员手动 | 等级几乎不变，迁过来的 exp 是死的；零风险、零热路径 |
| B 回复 +2 / 被赞 +1 / 打赏 +N | 每次回复点赞都多一次事务内写，而 `users` 行是**全站写热点**：某作者被赞时锁竞争集中在他那一行；`exp_events` 的幂等键正是为此准备的 |
| C B + 每日上限 | 多一张「今天拿了多少」的计数（或一次 `SUM` 查询，`idx_exp_events_user (user_id, created_at DESC)` 能服务） |

**本设计不替产品拍板**：`AddExp` 的接口与幂等键都已就位，选 A 不用改任何代码，选 B/C 只加调用点与一条规则常量。

---

## 7. 错误码（对照 §21.4 总表）

**总表已有、直接用**：`common.invalid_input` 400、`common.unauthorized` 401、`common.forbidden` 403、`common.not_found` 404、`common.rate_limited` 429、`common.internal` 500、`auth.email_unverified` 403、`forum.sanctioned` 403。

**本域新增 2 个**（写进 §21.4 总表）：

| code | 状态 | 出现场景 |
|---|---|---|
| `content.bad_mention` | 400 | `mention:<id>` 的 id 不存在 / 已封禁 / 超过 20 个（**§9.7 已定这个名字，总表漏了**） |
| `message.blocked` | 403 | 任一方向拉黑时发私信（不区分谁拉黑了谁，避免探测） |

**刻意不新增**：

- 「不能给自己发私信」→ `common.invalid_input` + `fields.peer`。
- `body` 超长 → `common.invalid_input` + `fields.body`（**不单列 `message.too_long`**；§11 U6）。
- 「佩戴没持有的头衔」→ `common.forbidden`（是权限式拒绝，不是参数错）。
- 「重复授予头衔」→ **200 幂等**，不报 409。
- 「通知不存在 / 不是我的」→ `common.not_found`（**不区分这两者**，避免枚举他人通知 id）。
- 「取消不存在的静音」→ **204 幂等**，不报 404。

---

## 8. 测试清单

### 8.1 通知

| 用例 | 断言 |
|---|---|
| 回复主题 → 作者收到 | 1 条，`type='reply'`，`link` 指向该帖，actor 是回复者 |
| 回复楼中楼 → 楼层作者收到 | 收件人是 `parent.author_id`，不是主题作者 |
| 主题作者回复自己的楼中楼 | **0 条** |
| 回复 + @ 主题作者 | **只 1 条**（reply 优先） |
| 同一事件入队两次 | 通知表仍 1 行，dedup_key 相同 |
| 帖子正文提及 vs issue 评论提及同一个人 | 两条通知的 dedup_key 不同（`mention:post:N` vs `mention:comment:M`），**两条都在** |
| 通知生成后再跑一次任务 | 行数不变、`read_at` 不变、不报错 |
| `reply_scope='none'` | 0 条 |
| 静音 `like` 类别 | 点赞不发、回复照发 |
| 静音 `link='post:<id>'` | 该楼层的回复与点赞都不发，别处照发 |
| 未读计数 | 插 3 → 3；标 1 已读 → 2；软删 1 未读 → 1 |
| `read {all:true}` 两次 | 第二次 `updated: 0` |
| `read {ids:[别人的 id]}` | 0 行，不报 404，不改他人数据 |
| 软删后拉列表 | 不出现、不计未读、dedup_key 仍占用（重放不复活） |
| `?kind=` 过滤 | 只返回该类别，且分页游标仍正确 |
| **EXPLAIN 闸门**（数据库文档 §12 第 11 条） | `notifications` 上无 Seq Scan（列表与未读各一次） |

### 8.2 私信

| 用例 | 断言 |
|---|---|
| A→B 发 3 条 | B 的 `unread-count = 3`，A 的 = 0 |
| B 打开会话 | B 的 = 0；A 仍 = 0 |
| 未读总数 = 会话列表未读之和 | §4.8 与 §4.6 两条 SQL 结果相等 |
| A 删自己发的 | A 的会话内不出现；**B 的仍出现**；B 未读不变 |
| B 删 A 发来的未读 | B 未读 -1 |
| 双方都删 | 两边都看不到；行仍在（cron 才硬删） |
| **回归：A 发 5 条给 B** | A 未读 0、B 未读 5（专防盲审 B3 复发） |
| A 拉黑 B 后 B 发 | 403 `message.blocked` |
| B 拉黑 A 后 A 发 | 403，且响应里没有「谁拉黑了谁」的信息 |
| 给自己发 / 不存在 handle / 空 body / 2001 rune | 400 / 404 / 400 / 400 |
| 并发 20 条乱序发送 | 全部落库；会话列表最后一条 = 最大 id |
| 会话列表 EXPLAIN | 两个 `Index Scan on messages`，`rows` ≤ 会话数×常数；无 Seq Scan |
| A、B 同时给对方发 | 两行 `(low,high)` 一致（CHECK 保证），互不阻塞 |

### 8.3 头衔与等级

| 用例 | 断言 |
|---|---|
| 授予 → 佩戴 → 收回 | 收回后 `equipped_title_id` 为 NULL（同事务），`user_titles` 无该行 |
| 佩戴没持有的 / 已归档的 | 403 / 400 |
| 重复授予 | 200；`user_titles` 仍 1 行 |
| 归档 | 目录不返回；已持有者的用户页仍返回该徽章 |
| 并发 `Equip(T1)` × 10 | 最终是其中一个，绝不是多个 |
| `AddExp(+100)` 两次不同 ref | `exp=200`、`level=2`、流水 2 行 |
| `AddExp(+100)` 两次相同 ref | `exp=100`、流水 1 行（第二次 0 行，返回当前值） |
| 等级不变量 | 对 0/99/100/400/900/10000 断言 `level`，并与 Go 的 `LevelForExp` 对照 |
| 自检（§9） | 造不符的行 → 自检**必须红** |
| 无 `title.grant` 调授予 | 403；路由层与 service 层各测一次（service 层直接调，不带中间件） |

### 8.4 @提及 / 搜索

| 用例 | 断言 |
|---|---|
| `[@A](mention:123)` | 解析出 `{123,"A"}` |
| 同一 id 写两次 | 只解析出一个 |
| id 不存在 / 已封禁 / 21 个提及 | 400 `content.bad_mention` |
| 自己提及自己 | 不产生通知 |
| 昵称里含 `]( `等 | 不炸（正则无回溯灾难），要么正确要么不匹配 |
| 渲染 | `content_html` 里是 `<a href="/u/<id>" data-mention="<id>">@<当前昵称></a>`；改昵称后再读显示新昵称 |
| 用户被删后渲染 | 回落到链接文本里的昵称快照，不出现空 `@` |
| `search?q=ab` | 前缀命中；同名时 `dup=true` |
| `search?q=a`（1 字符） | 空数组，**且不查库**（用 SQL 计数断言） |
| `search?q=%` | 转义后无命中（**不能返回全表**） |
| `search?q=<32 字符>` | 200，结果 ≤ limit |
| 搜索 EXPLAIN | 无 `Seq Scan on users` |

### 8.5 迁移与自检

| 用例 | 断言 |
|---|---|
| 空库 → 全部迁移 → 基本读写 | 本域 6 张表 + `users` 三列建得出；插非法 `type` 报错（CHECK 生效） |
| CHECK 值域自检 | `notifications.type` / `notification_mutes.type` / `exp_events.reason` 的 CHECK 值域 == Go 常量集合 |
| 外键索引自检 | 本域无未索引外键（含 `notification_mutes.user_id`、`user_titles.title_id`、`messages.sender_id`、`users.equipped_title_id`） |
| 表达式索引存在性 | `uq_users_username_lower` / `idx_users_nickname_lower` 存在且定义匹配（防 Atlas 删掉） |
| 负例夹具 | 故意去掉一个 FK 索引 → 自检必须红（空库跑通不算验收） |

---

## 9. 自检 SQL（进 `forum check` 与 CI，必须能红）

```sql
-- 1. 等级不变量
SELECT count(*) FROM users WHERE level <> floor(sqrt(exp / 100.0))::int + 1;

-- 2. 佩戴的头衔必须真的持有
SELECT count(*) FROM users u
 WHERE u.equipped_title_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM user_titles ut
                    WHERE ut.user_id = u.id AND ut.title_id = u.equipped_title_id);

-- 3. 经验流水与 users.exp 一致
SELECT count(*) FROM users u
 WHERE u.exp <> COALESCE((SELECT sum(e.delta) FROM exp_events e WHERE e.user_id = u.id), 0);

-- 4. 非 system 通知必须有 actor（actor 被清空只该发生在删号时）
SELECT count(*) FROM notifications WHERE actor_id IS NULL AND type <> 'system';
```

第 3 条在**导入完成后**必须先跑一次并清零（导入要同时写 `exp_events`，见 §5.4）；历史账号满足不了就在导入报告里列出并**显式豁免**（`reason='import'` 的行），而不是把自检放宽。

第 5 条（§4.8 与 §4.6 的未读口径一致）写成测试，不写成 SQL。

---

## 10. 关键取舍（写在设计里，不留到 review）

| 取舍 | 选了什么 | 代价 |
|---|---|---|
| 通知在事务里写还是任务里写 | **任务里写**（拍板 §5.7、后端方案 §4.3 定的路线），幂等靠 dedup_key | 通知晚到几百毫秒；任务重试耗尽后漏掉（有 dead 计数，无补偿） |
| 会话列表怎么算 | 按会话聚合，不按消息可见性过滤 | 可能出现「列表有最后一条、点进去是空的」 |
| `dup` 的口径 | 全站同名，不是结果集内同名 | 一次等值子查询（有索引） |
| 私信重复提交 | 不去重 | 网络超时重发会得到两条 |
| 通知邮件 | 不做 | 不看角标就不知道有新通知 |
| 静音命中 | 不生成行 | 取消静音后看不到期间的 |
| exp 发放 | 只留接口（§6.4） | 等级暂时是静态的 |

---

## 11. 未决问题

| 编号 | 问题 | 两种选择的代价 |
|---|---|---|
| **U1** | §21.2 只有 `PUT /notifications/mutes`，**没有取消静音的端点**。本设计加了 `DELETE /notifications/mutes`（同 body） | 加：多一个端点，但「不再通知」必须能撤销，否则是单向门。不加：点错一次永久失去那类通知，只能改库 |
| **U2** | §21.2 只有 `GET /messages`，**没有总未读端点**；但前端要「全局未读 30 秒轮询」+ 顶栏角标 | 加 `GET /messages/unread-count`（§4.8，两次 index-only count）。不加：顶栏每 30 秒拉整页会话列表再求和，与「省带宽是第一优先级」（性能与容量 §1）冲突 |
| **U3** | 通知列表加 `?kind=` 要不要预建 `(user_id, type, created_at DESC, id DESC)` 索引 | 建：多一个索引、多一次写放大。不建：类别稀疏时单次列表最多多扫几千行（§4.1 给了阈值 5000）。**倾向不建**，等 EXPLAIN 真超阈值再加 |
| **U4** | **SSE 三处互相矛盾**：后端方案 §20.3「明确不做」+ §21.2 又列了 `GET /messages/stream`；性能与容量 §4.2/§7 要求 standard 档上 SSE；数据库设计 §4.11 也写「standard 用 SSE」 | 本设计**按 §20.3 与拍板 §6 执行：不做 SSE**，只用 5s/30s 轮询；代价是端到端延迟停在 ≤5s（性能验收表「<1s」那一行作废）。**要翻这个决定必须同时改三份文档**，不能只在代码里加 |
| **U5** | exp 的发放规则（§6.4） | 见 §6.4 的 A/B/C 三档代价 |
| **U6** | `message.too_long` 要不要单列错误码 | 单列：前端能精确提示长度。并入 `common.invalid_input` + `fields.body`：少一个码。**倾向并入** |
| **U7** | `mention:` 链接会不会被 `bluemonday.UGCPolicy()` 剥掉——本轮**没有验证**（不写代码无法确认 goldmark 与 bluemonday 的相对顺序） | 若被剥：改写必须放在清洗**之前**（顺序 goldmark → Rewrite → bluemonday），或给 policy 显式放行 `mention` scheme。**在 `content_html` 上做后处理会引入第二次 HTML 解析，风险更高**。这是本域最可能踩的实现坑，实现前先用 10 行测试确认 |
| **U8** | `notification_mutes` 由谁拥有：本文放在 `internal/notify` 的 schema 里，但它语义偏用户设置 | 放 notify：本域闭环。放 user：与 `user_notice_settings` 同包，但 user 就要知道 notify 的 kind 枚举。**倾向维持放 notify** |
| **U9** | `user_notice_settings.reply_scope='followed'`（只提醒我关注的人）需要「关注」功能，本产品**没有关注**（收藏语义不同） | 现在就把 `followed` 从 CHECK 删掉（值域变 `all`/`none`）；或留着但行为等同 `all`（**静默不一致，最差**）。**倾向删掉**，等真有「关注」再加。这是别人域的表，需 Lead 定 |
| **U10** | 私信不通知、不发邮件（本设计） | 只看角标，用户可能长期不知道有新私信。要邮件提醒就得做「合并摘要 + 频率限制 + 用户开关」，是另一个模块的量级。**明确不做**，备案 |
| **U11** | 旧文档矛盾（不属于本域但影响本域，按规矩记录）：数据库设计 §4.11 写 `sanctions.board_id NULL = 全局`，后端方案 §20.2#21 写 `board_id(0=全局)`——**用 0 会直接违反外键**（盲审 M9 第 4 条）。本域的通知不碰哨兵，只带 `until` 与文案 | 不在本域解决；由处罚域定案 |
| **U12** | 公告/横幅的「不再显示」（`banner_dismissals`）与本域的「不再通知」（`notification_mutes`）是两套 | **不合并**（一个按横幅、一个按通知类别/内容），但前端文案必须写清「关掉横幅 ≠ 关掉通知」。本域不做横幅 |

---

## 12. 与旧文档的差异（回写建议）

| 处 | 旧写法 | 本设计 | 理由 |
|---|---|---|---|
| 数据库设计 §4.5 | `notifications.type varchar(32)` 无 CHECK | `varchar(16)` + CHECK | 盲审 M7(b)：真枚举必须带 CHECK，否则 §12 第 4 条自检看不见它 |
| 数据库设计 §4.5 | 静音表列名 `kind` | 列名 `type`（与通知表同名）；**HTTP 参数仍是 `?kind=`** | 盲审 B1 第 8 条：一个概念两个名字。列名统一为 `type`，wire 面保持 §21.2 已发布的 `kind=`（与 `GET /topics` 的 `?kind=` 同风格） |
| 数据库设计 §4.5 | 未读部分索引不含 `id` | `idx_notifications_inbox (user_id, created_at DESC, id DESC)` | §5.1 要求「排序键永远带 id 兜底」，索引必须同序 |
| 数据库设计 §4.11 | 未读部分索引漏 `sender_id` 条件 | 补上 | 盲审 B3 |
| 数据库设计 §4.11 | 只有 `(low_id,high_id,id DESC)` | 再加 `(high_id,low_id,id DESC)` | 盲审 B3 |
| 数据库设计 §4.11 | `messages.body text` | `varchar(2000)` + 非空 CHECK | §2.13：有业务上限的文本用 varchar |
| 数据库设计 §4.11 | 无 `public_id` | notifications / messages / titles 补 | 盲审 M6：这三个端点按 id 寻址 |
| 数据库设计 §4.11 | 无 `exp_events` 幂等键 | `(user_id,reason,ref) WHERE ref<>''` 唯一 | 盲审 M1：队列重试是常规路径 |
| 数据库设计 §4.11 | 没提 `idx_users_nickname_lower` | 新增 | 盲审 B1 第 5 条：搜索端点没有可用索引 |
| 数据库设计 §11.5 | 「头衔/等级/经验不进新库」 | 作废（§10.5 I4 已定：完整迁移） | 盲审 M9 第 2 条 |
| 性能与容量 §4.2 / §7 | standard 档私信 SSE | 作废 | §11 U4 |
| §21.2 | `GET /api/v1/messages/stream` | 删掉该行 | §11 U4 |
| §21.2 | 缺 `GET /messages/unread-count`、缺 `DELETE /notifications/mutes` | 补 | §11 U1 / U2 |
| §21.4 | 缺 `content.bad_mention`、`message.blocked` | 补 | §7 |
| RBAC权限树设计 §3 | `title.grant` 划给 superadmin | 按拍板 §1.3：`admin` 持有 `title.*` | 拍板优先 |
