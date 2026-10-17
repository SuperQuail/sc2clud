package appeal

import (
	"context"
	"time"
)

// 本文件是本域对外的几个小接口（v2 §4.2 第 3 条：各自 deps.go 定小接口，业务域之间不互相 import）。
// 实现由 app 层注入（modules.go 的适配器），所以本域不认识 topics / users / notifications 三张表 ——
// 只有 appeals 一张表是自己的（原生 SQL 在 ./pgsql）。

// TopicRef 是主题的判定列（C5 用）。
type TopicRef struct {
	ID       int64
	PublicID string // 对外 id：C5 把它原样存进 appeals.ref，出参也用它
	AuthorID int64
	Title    string
	// Visibility / ReviewState 都是公开谓词之外的状态：被驳回的帖子只有作者看得到，
	// 而申诉的对象正是它（所以 Ref 必须能带 canSeePending=true 取到）。
	Visibility  string // normal / hidden / deleted
	ReviewState string // pending / approved / rejected
}

// TopicLookup 由 app 层注入 forum 的实现。
//   - Ref 在主题不存在或已删（visibility=deleted）时返回 false；
//   - ReviewState 给 DTO 用（「我这帖现在算过还是没过」）。
type TopicLookup interface {
	Ref(ctx context.Context, publicID string, viewerID int64, canSeePending bool) (TopicRef, bool, error)
	ReviewState(ctx context.Context, topicID int64) (string, error)
}

// AccountLookup 是「用户名/邮箱 + 注册邮箱」这条自证链。
//
// **authz.Actor 里没有 handle 与 email**（判定不需要它们），而这条链路要写用户名、要发答复通知，
// 所以本域的一切用户信息都从这三个方法走，不去猜 Actor 里有什么。
type AccountLookup interface {
	// ByLogin 按用户名或邮箱精确匹配（大小写不敏感）找账号；匹配到的邮箱**必须**与 submittedEmail
	// 一致才算 verified（同一账号也可能用用户名提交）。找不到返回 verified=false，不报错。
	ByLogin(ctx context.Context, login, submittedEmail string) (userID int64, verified bool, err error)
	// Brief 把 user_id 换成 handle + 昵称 + 注册邮箱（队列的处理人 / C5 落库）。
	// 查不到返回零值，不报错。
	Brief(ctx context.Context, userID int64) (UserBrief, error)
	// PublicID 是用户的对外 id（出参里的 user_id）。查不到返回空串，不报错。
	PublicID(ctx context.Context, userID int64) (string, error)
}

// Reviewer 是「改判 → 真的把那篇帖子放行」的唯一落点，由 app 层注入 forum 的人工判定实现。
//
// 为什么不像 C6 那样只把判定写进本域的表：判定一个申诉说「改判」却不改帖子的 review_state，
// 就是「端点声称做到的事没做到」（盲测 X4 抓到的正是这一族）。所以改判必须真的动那篇帖子。
//
// 它内部自己开事务（forum.ReviewTopic 的形状），因此**不在本域的事务里调用**：
// 先落申诉的处理结果，再改帖子状态；帖子那一步失败只记日志、不回滚申诉 ——
// 让管理员看到「申诉处理了但帖子没放行」并重试，比让他以为整件事都没发生要好。
type Reviewer interface {
	ApproveTopic(ctx context.Context, actorUserID int64, topicPublicID, note string) error
}

// ManualEvent 是一次人工判定在 review_events 里留下的那一行（0020 建的这张表就是问
// 「它被谁、因为什么、判过几次」）。
type ManualEvent struct {
	TopicID int64
	ActorID int64
	Verdict string // approve / reject / review
	Reason  string
	// UniqueKey 让同一主题的同一轮只写一次（app 层按申诉单号拼），重放时不会写出第二行。
	UniqueKey string
}

// EventRecorder 由 app 层注入（review_events 是 aireview 域的表，本域不写别人的表）。
type EventRecorder interface {
	RecordManualReview(ctx context.Context, in ManualEvent) error
}

// AuditEntry 是一条审计（写 audit_logs 的活由 app 层注入的 audit.Writer 干，
// 与 report / forum 两个域同一个落点）。
type AuditEntry struct {
	ActorID  int64
	Action   string
	TargetID string
	Before   map[string]any
	After    map[string]any
	IP       string
}

// Auditor 由 app 注入 audit.Writer 的适配器。
type Auditor interface {
	Write(ctx context.Context, e AuditEntry) error
}

// NoticeInput 是一条给用户的站内通知（C4 的「被处理人能看到结果」那两个落点之一：
// 登录用户在通知中心看到；未登录的人拿单号 + 邮箱查）。
type NoticeInput struct {
	UserID int64
	// ActorID 是受理的管理员（0 = 系统）。
	ActorID int64
	// RefID 是这条申诉的内部 id：notify 的 payload 只放渲染要用的最小形状。
	RefID int64
	Title string
	Body  string
	Link  string
}

// Notifier 由 app 注入 notify 域的适配器（kind=system、ref_type=appeal）。
type Notifier interface {
	Send(ctx context.Context, in NoticeInput) error
}

// TxHandle 是一次事务的句柄。
//
// Executor 返回底层执行器（app 层返回 pgx.Tx 本身）：pgsql 层要拿它跑 SQL，
// 而本域不想 import pgx。它刻意返回 any —— 类型断言在 pgsql 层做，接口在这里保持最小。
type TxHandle interface {
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
	Executor() any
}

// TxRunner 由 app 层注入（包 pgxpool 的 Begin）。本域因此不 import ent，
// 也不为一张手写迁移的表引 schema。
type TxRunner interface {
	Begin(ctx context.Context) (TxHandle, error)
}

// Store 是本域原生 SQL 的落点（开发必读 §1 第 8 条：原生 SQL 只在各域 pgsql 包与手写迁移里）。
//
// SetTx/ClearTx 是「同一组方法在事务里与事务外都能用」的落点：report 域的 pgsql 用 NewTx(tx)
// 造第二个实例，而本域表只有一张、方法多一倍，所以改成显式换执行器 ——
// 调用方必须成对调用（service 的 withTx 是唯一的调用处）。
type Store interface {
	// SetTx / ClearTx 是「同一组方法在事务里与事务外都能用」的落点：
	// report 域的 pgsql 用 NewTx(tx) 造第二个实例，而本域表只有一张、方法多一倍，
	// 于是改成在同一实例上显式换执行器 —— Service.withTx 是唯一调用处，成对调用。
	SetTx(tx TxHandle)
	ClearTx()

	Insert(ctx context.Context, in NewAppeal) (id int64, no string, err error)
	PendingByTopic(ctx context.Context, topicID int64) (id int64, no string, err error)
	Ref(ctx context.Context, no, email string) (id int64, userID *int64, err error)
	CountRecent(ctx context.Context, userID int64, email, appealType string, since time.Time) (int, error)
	List(ctx context.Context, f ListFilter) ([]Row, error)
	GetByNo(ctx context.Context, no string) (*Row, error)
	NoByID(ctx context.Context, id int64) (string, error)
	DecideCAS(ctx context.Context, in DecideRow) (int64, error)
}

// NewAppeal 是建一条申诉的入参。
type NewAppeal struct {
	PublicID         string
	Type             string
	Username         string
	Email            string
	UserID           *int64
	IdentityVerified bool
	TopicID          *int64
	Ref              string
	Title            string
	Details          string
	Contact          string
	Now              time.Time
}

// DecideRow 是处理的 CAS 入参。
type DecideRow struct {
	No       string
	Status   string
	Decision string
	Response string
	Note     string
	Handler  int64
	Now      time.Time
}

// ListFilter 是两种列表（我的 / 管理端队列）共用的筛选。
type ListFilter struct {
	UserID   int64     // >0：只看这个人的（我的申诉）
	Status   string    // 空 = 全部
	Type     string    // 空 = 全部
	Q        string    // 空 = 不过滤；匹配单号 / 用户名 / 邮箱 / 标题（管理员搜人用）
	CursorAt time.Time // 零值 = 第一页
	CursorID int64
	Limit    int
}

// Row 是一行 appeals 的读视图（本域原生 SQL 的扫描目标）。Handler* 是 JOIN users 出来的处理人。
type Row struct {
	ID               int64
	No               string
	Type             string
	Username         string
	Email            string
	UserID           *int64
	IdentityVerified bool
	TopicID          *int64
	// TopicPublicID 是 JOIN topics 出来的对外 id（topic_id 出参用它）。
	// **不用「把内部 id 拼成一个假 uuid」那种办法**：前端拿它去 /topics/{id}，
	// 拼出来的串打不开任何页面，又是一条「接口 200、界面看着正常、其实什么都没发生」。
	TopicPublicID   *string
	Ref             string
	Title           string
	Details         string
	Contact         string
	Status          string
	Decision        *string
	Response        string
	HandleNote      string
	HandlerHandle   *string
	HandlerNickname *string
	HandledAt       *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}
