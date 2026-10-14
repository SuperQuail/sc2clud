package app

import (
	"context"
	"errors"
	"strings"

	"forum/internal/appeal"
	appealpgsql "forum/internal/appeal/pgsql"
	"forum/internal/auth"
	authpgsql "forum/internal/auth/pgsql"
	"forum/internal/authz"
	"forum/internal/forum"
	forumpgsql "forum/internal/forum/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
)

// 本文件是 appeal 域的跨域适配器（上线设计 §2 P1 决策 2：各域 deps.go 的小接口在这里用别的域的实现填上）。
//
// ── 为什么 appeal 的 Store 是每请求一份（与其他域的适配器不同）──
//
// appeal 域的原生 SQL 只有一张表、方法却多一倍，所以它的 Store 上带着一个「当前事务执行器」，
// 由 Service.withTx 成对 SetTx/ClearTx（见 appeal/pgsql 的说明）。**带可变状态的 Store 不能共享**：
// 两个请求同时进来时，A 的事务会被 B 的 ClearTx 清掉。因此它在这里 new、在 handler 里用、
// **不进 Modules** —— 与其他域「一个 Service 活整个进程」的模型不同，这是为省下
// 「每个方法都要在 txq 与 s.pg 之间选一个」付的代价。

// appealService 用一份新的 Store 装配一个 Service（app/appeal.go 的 handler 调它）。
// Reviewer / EventRecorder / Notifier / Auditor / TxRunner 都是无状态的，可以直接复用。
func (m *Modules) appealService() *appeal.Service {
	svc := appeal.NewService(appealpgsql.New(m.in.Pool), appealpgsql.NewAppRunner(m.in.Pool),
		appealTopics{m}, appealAccounts{m}, appealReviewer{m}, appealEvents{m}, appealAudit{m},
		appealNotify{m}, m.Captcha, m.in.Clock, m.in.Log)
	if appealCaptchaForTest != nil {
		svc.SetCaptchaForTest(appealCaptchaForTest)
	}
	return svc
}

// appealCaptchaForTest 让 e2e 换掉人机闸门（**只给测试赋值**：生产代码里没有写它的地方）。
//
// 为什么要这个口子：真出题器的答案是随机画的图，e2e 拿不到；而绕开验证码 = 测的不是那条路。
// 测试通过 appeal.Service.SetCaptchaForTest 装替身（见appeal/service.go 的同名说明）。
var appealCaptchaForTest appeal.Captcha

// ── 主题（C5 的对象）──

// appealTopics 实现 appeal.TopicLookup。读走 forum/pgsql 既有的入口，本适配器**不重写 SQL**
// （开发必读 §1 第 8 条：各表由拥有它的域读）。
type appealTopics struct{ m *Modules }

func (a appealTopics) Ref(ctx context.Context, publicID string, viewerID int64, canSeePending bool) (appeal.TopicRef, bool, error) {
	ref, err := a.m.fstore.TopicRef(ctx, publicID, viewerID, canSeePending)
	if errors.Is(err, forumpgsql.ErrNoRows) {
		return appeal.TopicRef{}, false, nil
	}
	if err != nil {
		return appeal.TopicRef{}, false, err
	}
	// TopicRef 是按 public_id 查的，但它自己不回传 public_id，而 C5 要把它原样写进 appeals.ref；
	// TopicCard 带 public_id 与 title（正好是这里要的其余部分）。
	card, err := a.m.fstore.TopicCard(ctx, ref.ID)
	if errors.Is(err, forumpgsql.ErrNoRows) {
		return appeal.TopicRef{}, false, nil
	}
	if err != nil {
		return appeal.TopicRef{}, false, err
	}
	return appeal.TopicRef{
		ID: ref.ID, PublicID: card.PublicID, AuthorID: ref.AuthorID, Title: card.Title,
		Visibility: ref.Visibility, ReviewState: ref.ReviewState,
	}, true, nil
}

func (a appealTopics) ReviewState(ctx context.Context, topicID int64) (string, error) {
	card, err := a.m.fstore.TopicCard(ctx, topicID)
	if errors.Is(err, forumpgsql.ErrNoRows) {
		return "", nil // 主题被删了：不是错误，DTO 里那一格空着
	}
	if err != nil {
		return "", err
	}
	return card.ReviewState, nil
}

// ── 账号（自证链）──

// appealAccounts 实现 appeal.AccountLookup。
//
// 自证只回答一个问题：**这个用户名/邮箱指向的账号，注册邮箱是不是提交的那个**。
// 走 user.GetAuthRow（按「用户名或邮箱」精确匹配、大小写不敏感，与登录同一条查询）。
type appealAccounts struct{ m *Modules }

func (a appealAccounts) ByLogin(ctx context.Context, login, submittedEmail string) (int64, bool, error) {
	login = strings.TrimSpace(login)
	if login == "" {
		return 0, false, nil
	}
	row, err := a.m.User.GetAuthRow(ctx, login)
	if err != nil {
		if errors.Is(err, auth.ErrUserNotFound) || errors.Is(err, apperr.ErrNotFound) {
			return 0, false, nil // 没有这个账号：照收，identity_verified=false
		}
		return 0, false, err
	}
	return row.ID, strings.EqualFold(row.Email, strings.TrimSpace(submittedEmail)), nil
}

func (a appealAccounts) Brief(ctx context.Context, userID int64) (appeal.UserBrief, error) {
	b, err := a.m.User.BriefByID(ctx, userID)
	if err != nil {
		return appeal.UserBrief{}, err
	}
	// Email 只在 C5 落库时用（appeals.email 是 NOT NULL）。取不到就只给 handle/nickname：
	// 「读不到邮箱」不该让队列整页失败。
	row, err := a.m.User.GetAuthRow(ctx, b.Handle)
	if err != nil {
		return appeal.UserBrief{Handle: b.Handle, Nickname: b.Nickname}, nil
	}
	return appeal.UserBrief{Handle: b.Handle, Nickname: b.Nickname, Email: row.Email}, nil
}

func (a appealAccounts) PublicID(ctx context.Context, userID int64) (string, error) {
	b, err := a.m.User.BriefByID(ctx, userID)
	if err != nil {
		return "", err
	}
	return b.PublicID, nil
}

// ── 改判（真的把帖子放行）──

// appealReviewer 实现 appeal.Reviewer：调用 forum 的人工判定（与后台审核队列同一个 service 方法），
// 于是改判与人工放行的副作用完全一致 —— review_state + 审计 + search:index + notify:review 四条都在那边。
type appealReviewer struct{ m *Modules }

func (a appealReviewer) ApproveTopic(ctx context.Context, actorUserID int64, topicPublicID, note string) error {
	actor, err := a.m.actorByID(ctx, actorUserID)
	if err != nil {
		return err
	}
	// expectedUpdatedAt 不传：这是管理员在处理申诉，不是「审核员手上那一版」的场景
	//（forum.ReviewTopic 的注释里写明内部调用方可以不给）。
	_, err = a.m.Forum.ReviewTopic(ctx, actor, topicPublicID, forum.ReviewApprove, note)
	return err
}

// actorByID 从库里重算一个人的权限集合（后台 / 没有 gin 上下文的身份）。
//
// **不伪造身份**（例如拿 IsSuper=true 短路）：那会让「谁判的」在审计里失去意义。
// 走 auth 域既有的 LoadActorSQL —— 与解析会话时算的是同一个闭包，只是这里从 user_id 出发
// （会话那条路的入口是 token，本包没有 token）。
func (m *Modules) actorByID(ctx context.Context, userID int64) (*authz.Actor, error) {
	brief, err := m.User.BriefByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	ar, err := authpgsql.LoadActor(ctx, m.in.DB, brief.RoleID, userID, m.in.Clock.Now())
	if err != nil {
		return nil, err
	}
	return &authz.Actor{
		UserID: userID, PublicID: ar.PublicID, Perms: authz.NewSet(ar.PermKeys...),
		BoardIDs: ar.BoardIDs, RoleID: ar.RoleID, RoleKey: ar.RoleKey, RoleName: ar.RoleName,
		RoleBadge: derefStr(ar.RoleBadge), IsSuper: ar.IsSuper,
		EmailVerified: ar.EmailVerified != nil, Activated: ar.ActivatedAt != nil, Status: ar.Status,
	}, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ── 人工判定事件（0020 的 review_events）──

// appealEvents 实现 appeal.EventRecorder：改判也是**人工判定**，
// 「谁判的、为什么、判过几次」要能在同一张表里看到（C7 的 M4 说的就是这张表没被写）。
type appealEvents struct{ m *Modules }

func (a appealEvents) RecordManualReview(ctx context.Context, in appeal.ManualEvent) error {
	// 幂等：重放同一条申诉时按 (topic_id, reason) 去重（review_events 没有 unique_key 列，
	// 而它记的是事实「判定发生过几次」，多写一行就是多算一次）。
	var exists bool
	if err := a.m.in.Pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM review_events WHERE topic_id = $1::bigint AND reason = $2::varchar)`,
		in.TopicID, clip(in.Reason, 200)).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	// visibility 不动：改判只到「放行」，藏不藏是另一件事（与 forum.ReviewTopic 的 approve 一致）。
	_, err := a.m.in.Pool.Exec(ctx,
		`INSERT INTO review_events (topic_id, trigger, source, verdict, reason, actor_id)
		 VALUES ($1::bigint, 'manual', 'manual', $2::text, $3::varchar, $4::bigint)`,
		in.TopicID, in.Verdict, clip(in.Reason, 200), in.ActorID)
	return err
}

// clip 按字符（不是字节）截断，避免把一个中文字切成两半。
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ── 审计 / 通知 ──

// appealAudit 实现 appeal.Auditor。
//
// shortcut: 审计行**不与申诉的处理同事务**（tx=nil）。原因见文件头：appeal 的 Store 是每请求一份，
// 而 audit.Writer 要的是 *ent.Tx，两者拿不到同一个句柄。要严格同事务得让 handler 能取到 *ent.Tx
// （现在没有这个入口），那动的是 audit 域与事务的形状，不在本包作用域。
type appealAudit struct{ m *Modules }

func (a appealAudit) Write(ctx context.Context, e appeal.AuditEntry) error {
	detail := map[string]any{}
	if len(e.Before) > 0 {
		detail["before"] = e.Before
	}
	if len(e.After) > 0 {
		detail["after"] = e.After
	}
	return a.m.audit.Write(ctx, nil, audit.Entry{
		ActorID: e.ActorID, Action: e.Action, TargetType: "appeal",
		TargetID: e.TargetID, Detail: detail, IP: e.IP,
	})
}

// appealNotify 实现 appeal.Notifier：写一条 kind=system 的站内通知。
//
// kind 用 system 而不是 review：**申诉的答复不是审核结论**（改判那条已经由 forum 的判定
// 发了 review 通知），而 kind 的值域由 0007 的 CHECK 定死（reply/mention/like/reward/review/sanction/system）——
// 为它加一个新类别要动迁移与通知中心的分档，收益不抵成本。
type appealNotify struct{ m *Modules }

func (a appealNotify) Send(ctx context.Context, in appeal.NoticeInput) error {
	// 直接发（不走队列）：队列任务类型只有 d4 §5.1 那六种，系统通知没有触发它的领域事件。
	// notify.NotifySystem 自己开事务，并把「静音 + 消息设置」的判定一起做了。
	return a.m.Notify.NotifySystem(ctx, in.UserID, in.Body, in.Link)
}
