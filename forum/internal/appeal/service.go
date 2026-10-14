package appeal

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/captcha"
	"forum/internal/platform/clock"
	"forum/internal/platform/idgen"
)

// 管理端要的权限点（handler 与 service 两处都判：service 是 CLI / 其它入口那条路的兜底）。
//
// 沿用既有常量、**不新造**：
//   - 队列：report.handle —— 它就是「处理内容治理工单的那个点」，申诉与举报本来就是同一批人
//     在同一个后台屏里处理；
//   - 改判（overturned）：额外要 post.review —— 它真的会改那篇帖子的审核态，
//     而「谁能判帖子过不过」有它自己的点（forum 的人工队列用的就是它）。
//
// 只有 report.handle 的人拿不到「改判」这个动作，但**能处理申诉**（维持 + 答复）。
const (
	permQueue  = authz.PermReportHandle
	permDecide = authz.PermPostReview
)

// auditAction 是处理申诉的审计动作名（report 域同样只有「处理」写审计：appeals 表本身就是留痕）。
const auditAction = "appeal.handle"

// Service 是申诉域的全部业务逻辑。actor 由 handler 显式传入（拍板 §5.3），不从 context 取。
type Service struct {
	store    Store
	txr      TxRunner
	topics   TopicLookup
	accounts AccountLookup
	reviewer Reviewer
	events   EventRecorder
	audit    Auditor
	notify   Notifier
	captcha  Captcha
	clk      clock.Clock
	log      *slog.Logger
}

// Captcha 是 platform/captcha 的只读视图（本域不 import auth：见 errors.go 的说明）。
type Captcha interface {
	Verify(ctx context.Context, id, answer string) error
}

// SetCaptchaForTest 换掉人机闸门（**只给测试用**，e2e 要能走完整条路而不必识字）。
//
// 为什么要这个口子：真实出题器的答案是随机画的图，e2e 拿不到；而绕开验证码 = 测的不是那条路。
// 它导出一个设置器而不是给 Service 加导出的字段：生产代码里没有写它的地方（app 层的装配
// 只调 NewService 一次），而测试文件在别的包（internal/app）里，需要这个入口。
//
// shortcut: 它是**生产二进制里也存在的一个 setter**（Go 没有 package-private 的测试口）。
// 风险可接受：调用它需要拿到 *Service（只有 app 与测试持有），且没有任何非测试调用点。
func (s *Service) SetCaptchaForTest(c Captcha) { s.captcha = c }

// NewService 的签名就是接线契约（app/modules.go 的装配处）。
func NewService(store Store, txr TxRunner, topics TopicLookup, accounts AccountLookup,
	reviewer Reviewer, events EventRecorder, audit Auditor, notify Notifier, cap Captcha,
	clk clock.Clock, log *slog.Logger) *Service {
	return &Service{store: store, txr: txr, topics: topics, accounts: accounts,
		reviewer: reviewer, events: events, audit: audit, notify: notify, captcha: cap, clk: clk, log: log}
}

// ---- 公共小件 ----

// requireActor 是「这条路由必须登录」的 service 层兜底。
func requireActor(a *authz.Actor) error {
	if a == nil || a.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	return nil
}

// requirePerm 是权限兜底（authz 的既定顺序：未登录 401 → 超管短路 → 权限集合）。
func requirePerm(a *authz.Actor, perm string) error {
	if err := requireActor(a); err != nil {
		return err
	}
	if a.IsSuper || a.Perms.Has(perm) {
		return nil
	}
	return apperr.ErrForbidden
}

// withTx 开一个事务并把它绑到 store 上（pgsql.Store.SetTx）。
//
// **为什么不是「换一个 Store 实例」**：report 域的 pgsql 用 NewTx(tx) 造第二个实例，
// 但那要求每个方法都写成「在 txq 与 s.pg 之间选一个」；本域方法多一倍，显式换执行器更短。
// 代价（写清）：Store 上有可变状态，所以它必须是**每请求一份** —— app 层在 handler 里
// new 一个（app/appeal.go），不放进 Modules。
func (s *Service) withTx(ctx context.Context, fn func(ctx context.Context) error) error {
	tx, err := s.txr.Begin(ctx)
	if err != nil {
		return fmt.Errorf("appeal: begin tx: %w", err)
	}
	s.store.SetTx(tx)
	defer s.store.ClearTx()
	if err := fn(ctx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// checkCaptcha 是免登录那条路的人机闸门。与 auth 的 checkCaptcha 同一形状，但**要求不同**：
// 注册 / 登录按 config 的三档走，这条链路**永远要求**（它免登录，验证码是唯一的机器闸门）。
// 没装配出题器时拒绝放行：静默取消人机验证 = 这条链路变成公开的写接口。
func (s *Service) checkCaptcha(ctx context.Context, id, answer string) error {
	if s.captcha == nil {
		return ErrCaptchaUnavailable
	}
	if id == "" || answer == "" {
		return ErrCaptchaRequired
	}
	switch err := s.captcha.Verify(ctx, id, answer); {
	case err == nil:
		return nil
	case errors.Is(err, captcha.ErrWrong):
		return ErrCaptchaWrong
	case errors.Is(err, captcha.ErrUnavailable):
		s.log.Error("appeal: 验证码服务不可用", "err", err.Error())
		return ErrCaptchaUnavailable
	default:
		s.log.Error("appeal: 校验验证码失败", "err", err.Error())
		return apperr.ErrInternal
	}
}

// ---- 游标分页（与 report 同一套：排序键永远带 id 兜底）----

type cursor struct {
	T  time.Time `json:"t"`
	ID int64     `json:"id"`
}

func encodeCursor(t time.Time, id int64) string {
	b, err := json.Marshal(cursor{T: t.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (*cursor, error) {
	if s == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, badCursor()
	}
	var c cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, badCursor()
	}
	return &c, nil
}

func badCursor() error {
	return apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
}

func limitOf(n int) int {
	switch {
	case n <= 0:
		return defaultLimit
	case n > maxLimit:
		return maxLimit
	default:
		return n
	}
}

// ---- DTO 组装 ----

// toDTO 把一行转成对外形态。
// TopicReviewState 走一次额外的读（app 层注入的 TopicLookup）：**只对 review_reject 查**，
// 其余三种事由没有对象，不该为它们各查一次不存在的主题。
func (s *Service) toDTO(ctx context.Context, r Row) (Appeal, error) {
	out := Appeal{
		No: r.No, Type: r.Type, Username: r.Username, Email: r.Email,
		IdentityVerified: r.IdentityVerified, Ref: r.Ref, Title: r.Title, Details: r.Details,
		Contact: r.Contact, Status: r.Status, Decision: r.Decision, Response: r.Response,
		HandleNote: r.HandleNote, HandledAt: utcPtr(r.HandledAt),
		Eta: ETA(r.Type), CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
	}
	if r.UserID != nil {
		out.UserID = s.publicID(ctx, *r.UserID)
	}
	if r.TopicID != nil {
		out.TopicID = r.TopicPublicID
		if s.topics != nil && out.TopicID != nil {
			st, err := s.topics.ReviewState(ctx, *r.TopicID)
			if err != nil {
				return Appeal{}, fmt.Errorf("appeal: 读主题审核态: %w", err)
			}
			out.TopicReviewState = &st
		}
	}
	// 处理人：SQL 里已经 LEFT JOIN users 带出来了（handled_by 被 SET NULL 时两列都是 NULL，
	// 那种情况就是「处理人已注销」，不再查第二次）。
	if r.HandlerHandle != nil {
		out.Handler = &UserBrief{Handle: *r.HandlerHandle, Nickname: deref(r.HandlerNickname)}
	}
	return out, nil
}

// publicID 把内部 user_id 换成公开 id；查不到返回 nil（用户可能已注销 —— 那不是错误）。
func (s *Service) publicID(ctx context.Context, userID int64) *string {
	if s.accounts == nil {
		return nil
	}
	pid, err := s.accounts.PublicID(ctx, userID)
	if err != nil || pid == "" {
		return nil
	}
	return &pid
}

// ---- 提交（C4）----

// Create 是 POST /appeals：**免登录**。
//
// 判定顺序：事由自洽 → 验证码 → 自证身份 → 24 小时额度 → 落库。
// 身份验不过也收（identity_verified=false）：收下是本域存在的理由，人判的时候看那一列。
func (s *Service) Create(ctx context.Context, actor *authz.Actor, in CreateInput) (*SubmitResult, error) {
	username := strings.TrimSpace(in.Username)
	email := strings.TrimSpace(in.Email)
	title := strings.TrimSpace(in.Title)
	details := strings.TrimSpace(in.Details)
	loggedIn := actor != nil && actor.UserID > 0

	if in.Type == TypeReviewReject {
		// C5 只认作者本人（拍板 §10.10-1）。免登录时我们连「你是谁」都证明不了，
		// 只能让他去登录 —— routes/appeal.tsx 里已经先拦了一次（NEED_LOGIN）。
		return nil, apperr.Invalid(map[string]string{"type": "帖子审核申诉只认作者本人，请先登录后从帖子页提交"})
	}
	if username == "" {
		// 登录态提交时可以省掉用户名（身份已经确认）；免登录时它是自证的第一半。
		// **handle 从 accounts 拿**：authz.Actor 里没有它（判定不需要）。
		if loggedIn && s.accounts != nil {
			if b, err := s.accounts.Brief(ctx, actor.UserID); err == nil {
				username = b.Handle
			}
		}
		if username == "" {
			return nil, apperr.Invalid(map[string]string{"username": "用户名是必填的"})
		}
	}
	if err := s.checkCaptcha(ctx, in.CaptchaID, in.CaptchaAnswer); err != nil {
		return nil, err
	}

	// 自证：用户名或邮箱命中一个账号，且提交的邮箱与账号注册邮箱一致。
	// **登录态也走同一条判定**（会话是更强的证据，但管理员看的是 identity_verified 这一列）。
	var userID *int64
	verified := false
	if s.accounts != nil {
		uid, ok, err := s.accounts.ByLogin(ctx, username, email)
		if err != nil {
			return nil, err
		}
		if ok {
			verified, userID = true, &uid
		}
	}
	if loggedIn {
		uid := actor.UserID
		userID = &uid // 会话优先：队列按 user_id 找人比按用户名可靠
		if !verified && s.accounts != nil {
			// 登录态也走同一条自证：他的 handle 必须能对上提交的邮箱（否则 identity_verified 恒 false，
			// 队列上就少了一档可信度）。
			if handle, err := s.accounts.Brief(ctx, actor.UserID); err == nil && handle.Handle != "" {
				if _, ok, err := s.accounts.ByLogin(ctx, handle.Handle, email); err == nil && ok {
					verified = true
				}
			}
		}
	}

	// 额度：同一身份 24 小时内最多 3 条同类型。
	var uid int64
	if userID != nil {
		uid = *userID
	}
	n, err := s.store.CountRecent(ctx, uid, email, in.Type, s.clk.Now().Add(-dayWindow*time.Hour))
	if err != nil {
		return nil, err
	}
	if n >= maxPerDay {
		return nil, ErrRateLimited
	}

	pid, err := idgen.NewPublicID()
	if err != nil {
		return nil, fmt.Errorf("appeal: 生成 public_id: %w", err)
	}
	var (
		no string
	)
	err = s.withTx(ctx, func(ctx context.Context) error {
		_, newNo, err := s.store.Insert(ctx, NewAppeal{
			PublicID: pid.String(), Type: in.Type, Username: username, Email: email,
			UserID: userID, IdentityVerified: verified,
			Ref: strings.TrimSpace(in.Ref), Title: title, Details: details,
			Contact: strings.TrimSpace(in.Contact), Now: s.clk.Now(),
		})
		if err != nil {
			return err
		}
		no = newNo
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &SubmitResult{No: no, Eta: ETA(in.Type), Status: StatusPending, Created: true}, nil
}

// Lookup 是免登录查进展：**单号 + 邮箱**（两条都对上才给看）。
// 这是「被处理人能看到结果」在未登录那一侧的落点：被封的人登不进来，
// 只靠邮件答复等于他没有可回查的地方。
func (s *Service) Lookup(ctx context.Context, in LookupInput) (*Appeal, error) {
	row, err := s.byNoEmail(ctx, strings.TrimSpace(in.No), strings.TrimSpace(in.Email))
	if err != nil {
		return nil, err
	}
	out, err := s.toDTO(ctx, *row)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// byNoEmail 是「单号 + 邮箱」解一行，两条都对不上时给同一个 404（不区分：「单号不存在」
// 与「邮箱不对」的差别等于给枚举单号的人一个预言机）。
func (s *Service) byNoEmail(ctx context.Context, no, email string) (*Row, error) {
	if _, _, err := s.store.Ref(ctx, no, email); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	row, err := s.store.GetByNo(ctx, no)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return row, nil
}

// Mine 是 GET /me/appeals：登录用户看自己全部（含已处理）。本人语义，不挂权限点。
func (s *Service) Mine(ctx context.Context, actor *authz.Actor, in MineInput) (*Page, error) {
	if err := requireActor(actor); err != nil {
		return nil, err
	}
	cur, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	f := ListFilter{UserID: actor.UserID, Limit: limitOf(in.Limit) + 1}
	if cur != nil {
		f.CursorAt, f.CursorID = cur.T, cur.ID
	}
	return s.page(ctx, f)
}

// Queue 是 GET /admin/appeals：管理端队列（?status=&type=&q=&limit=&cursor=）。
func (s *Service) Queue(ctx context.Context, actor *authz.Actor, in QueueInput) (*Page, error) {
	if err := requirePerm(actor, permQueue); err != nil {
		return nil, err
	}
	cur, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	f := ListFilter{
		Status: in.Status, Type: in.Type, Q: strings.TrimSpace(in.Q),
		Limit: limitOf(in.Limit) + 1,
	}
	if cur != nil {
		f.CursorAt, f.CursorID = cur.T, cur.ID
	}
	return s.page(ctx, f)
}

// page 裁掉多取的那一条并算出 next_cursor。
func (s *Service) page(ctx context.Context, f ListFilter) (*Page, error) {
	rows, err := s.store.List(ctx, f)
	if err != nil {
		return nil, err
	}
	limit := f.Limit - 1
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	items := make([]Appeal, 0, len(rows))
	for _, r := range rows {
		dto, err := s.toDTO(ctx, r)
		if err != nil {
			return nil, err
		}
		items = append(items, dto)
	}
	return &Page{Items: items, NextCursor: next}, nil
}

// ---- 处理（管理端）----

// Decide 是 POST /admin/appeals/{no}。
//
// 判定顺序（与 report 的处理同一套）：权限 → 读行（404）→ 已是终态（409）→ CAS（0 行再 409）→ 审计。
// 三条副作用在**同一个事务**里：CAS + 审计 + 给提交人的通知（登录用户才有收件人）。
// 改判（overturned）还有第四步，在事务**外面**（forum.ReviewTopic 自己开事务，见 deps.go 的说明）。
func (s *Service) Decide(ctx context.Context, actor *authz.Actor, in DecideInput) (*Appeal, error) {
	if err := requirePerm(actor, permQueue); err != nil {
		return nil, err
	}
	response := strings.TrimSpace(in.Response)
	note := strings.TrimSpace(in.Note)
	if response == "" {
		// 处理了却不给答复 = 本域要消灭的那个形态（盲审二号：点完申诉界面不变）。
		return nil, apperr.Invalid(map[string]string{"response": "必须写答复（提交人会看到）"})
	}
	if in.Decision == DecisionOverturned {
		// 改判真的会动那篇帖子：没这个点的人只能维持（它属于「谁能判帖子过不过」）。
		if err := requirePerm(actor, permDecide); err != nil {
			return nil, err
		}
	}
	no := strings.TrimSpace(in.No)

	row, err := s.store.GetByNo(ctx, no)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if row.Status != StatusPending {
		return nil, ErrHandled
	}
	status := StatusReplied
	if in.Close {
		status = StatusClosed
	}
	now := s.clk.Now()

	err = s.withTx(ctx, func(ctx context.Context) error {
		n, err := s.store.DecideCAS(ctx, DecideRow{
			No: no, Status: status, Decision: in.Decision, Response: response,
			Note: note, Handler: actor.UserID, Now: now,
		})
		if err != nil {
			return err
		}
		if n == 0 {
			// 读行之后、CAS 之前有人处理掉了（并发重放）：给确定的 409，且不写第二份审计与通知。
			return ErrHandled
		}
		if err := s.audit.Write(ctx, AuditEntry{
			ActorID: actor.UserID, Action: auditAction, TargetID: no,
			Before: map[string]any{"status": row.Status},
			After:  map[string]any{"status": status, "decision": in.Decision, "response": response, "note": note},
			IP:     in.IP,
		}); err != nil {
			return err
		}
		// 通知**只有登录用户收得到**（未登录的人拿单号 + 邮箱查，见 Lookup）。
		if row.UserID == nil {
			return nil
		}
		return s.notify.Send(ctx, NoticeInput{
			UserID: *row.UserID, ActorID: actor.UserID, RefID: row.ID,
			Title: "你的申诉有结果了",
			Body:  response,
			Link:  "/appeals?no=" + no,
		})
	})
	if err != nil {
		return nil, err
	}

	// 改判：把帖子真的放行。这一步在事务外，失败只记日志不回滚 —— 管理员会看到
	// topic_review_state 没变，可以重试；让他以为整件事都没发生更糟。
	if in.Decision == DecisionOverturned && row.TopicID != nil {
		if s.reviewer == nil {
			s.log.Error("appeal: 改判但没接审核实现，帖子不会被放行", "no", no)
		} else if row.TopicPublicID != nil {
			if err := s.reviewer.ApproveTopic(ctx, actor.UserID, *row.TopicPublicID, "申诉改判："+response); err != nil {
				s.log.Error("appeal: 改判后放行帖子失败（申诉已处理，帖子未变）",
					"no", no, "topic", *row.TopicPublicID, "err", err.Error())
			} else if s.events != nil {
				// 0020 的 review_events：「它被谁、因为什么、判过几次」—— 人工判定也要留一行（C7 M4）。
				// 失败同样只记日志：帖子已经放行了，事件表缺一行不该变成「处理失败」。
				if err := s.events.RecordManualReview(ctx, ManualEvent{
					TopicID: *row.TopicID, ActorID: actor.UserID, Verdict: "review",
					Reason: "申诉改判（" + no + "）：" + response, UniqueKey: "appeal:" + no,
				}); err != nil {
					s.log.Error("appeal: 写 review_events 失败", "no", no, "err", err.Error())
				}
			}
		}
	}

	updated, err := s.store.GetByNo(ctx, no)
	if err != nil {
		return nil, err
	}
	out, err := s.toDTO(ctx, *updated)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- C5：作者对审核结果申诉 ----

// AppealReview 是 POST /topics/{id}/review/appeal（拍板 §10.10-1：登录 + 仅作者 + 幂等）。
//
// 幂等落在 uq_appeals_topic_pending 上：**同一篇帖子只留一条未处理的申诉**。
// 重复提交返回既有那条（Created=false，handler 回 200 而不是 202）——
// 连点两次不该看到错误，他的目的已经达成（与 report 的 U5 同一个取舍）。
func (s *Service) AppealReview(ctx context.Context, actor *authz.Actor, topicPublicID string, in ReviewAppealInput) (*SubmitResult, error) {
	if err := requireActor(actor); err != nil {
		return nil, err
	}
	if s.topics == nil {
		return nil, apperr.ErrInternal
	}
	// canSeePending=true：被驳回（rejected）与待审（pending）的帖子正是要申诉的对象，
	// 而这两个状态在公开谓词下都取不到。
	ref, ok, err := s.topics.Ref(ctx, topicPublicID, actor.UserID, true)
	if err != nil {
		return nil, err
	}
	if !ok || ref.Visibility == "deleted" {
		return nil, apperr.ErrNotFound
	}
	if ref.AuthorID != actor.UserID {
		// 只有作者能申诉（拍板 §10.10-1）。这里给 403 而不是 404：路由上是「你的帖子」这一族，
		// 而且作者本来就知道这篇帖子存在（他就是作者）。
		return nil, apperr.ErrForbidden
	}
	if ref.ReviewState == "approved" {
		// 已经过了：没什么可申诉的。说清楚比默默收下一条没有对象的申诉好。
		return nil, apperr.Invalid(map[string]string{"topic": "这篇帖子已经通过审核了，不需要申诉"})
	}

	// 落库要用户名与注册邮箱（appeals 两列都是 NOT NULL）。**从这里拿，不从 actor 拿**：
	// authz.Actor 里没有 handle / email（见 deps.go 的说明）。
	self, err := s.accounts.Brief(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	login, email := self.Handle, self.Email
	if login == "" {
		return nil, apperr.ErrInternal
	}
	reason := strings.TrimSpace(in.Reason)
	details := reason
	if details == "" {
		details = "作者认为这篇帖子被误判，申请人工复核。"
	}
	title := "对《" + trimRunes(ref.Title, 60) + "》的审核结果申诉"

	pid, err := idgen.NewPublicID()
	if err != nil {
		return nil, fmt.Errorf("appeal: 生成 public_id: %w", err)
	}
	var (
		id      int64
		no      string
		created bool
	)
	err = s.withTx(ctx, func(ctx context.Context) error {
		newID, newNo, err := s.store.Insert(ctx, NewAppeal{
			PublicID: pid.String(), Type: TypeReviewReject,
			Username: login, Email: email,
			UserID: &actor.UserID, IdentityVerified: true,
			TopicID: &ref.ID, Ref: ref.PublicID, Title: title, Details: details,
			Now: s.clk.Now(),
		})
		if err == nil {
			id, no, created = newID, newNo, true
			return nil
		}
		return err
	})
	if err != nil {
		// 撞 uq_appeals_topic_pending = 已经有一条未处理的（幂等）。**失败的那条语句会把事务
		// 置为 aborted**，所以回查只能在事务外另开一次读。
		existingID, existingNo, ferr := s.store.PendingByTopic(ctx, ref.ID)
		if ferr != nil {
			if errors.Is(ferr, sql.ErrNoRows) {
				return nil, err // 不是幂等冲突，把原始错误还回去
			}
			return nil, ferr
		}
		_ = existingID
		id, no, created = existingID, existingNo, false
	}
	if !created {
		return &SubmitResult{No: no, Eta: ETA(TypeReviewReject), Status: StatusPending, Created: false}, nil
	}
	// 让作者在页面上看到「已进入人工复核」（设计稿 success-view 的 done.follow 承诺的正是这条）：
	// 帖子横幅读的是 topics.review_note，而这一列只有论坛域能写 —— 由 app 层注入的 Reviewer 之外
	// 没有再开一个写口，所以这里只记审计，横幅那条在进度文件的「下一步」里（见进度文件）。
	if err := s.recordSubmit(ctx, actor, id, no, topicPublicID); err != nil {
		return nil, err
	}
	return &SubmitResult{No: no, Eta: ETA(TypeReviewReject), Status: StatusPending, Created: true}, nil
}

// recordSubmit 写一条「作者提交了申诉」的审计（提交本身不写审计的例外：申诉是纠纷的起点，
// 事后要能回答「他什么时候申诉的」）。失败不回滚：申诉已经落库了。
func (s *Service) recordSubmit(ctx context.Context, actor *authz.Actor, id int64, no, topicPublicID string) error {
	if s.audit == nil {
		return nil
	}
	return s.audit.Write(ctx, AuditEntry{
		ActorID: actor.UserID, Action: "appeal.submit", TargetID: no,
		After: map[string]any{"type": TypeReviewReject, "topic": topicPublicID},
	})
}

// ---- 小工具 ----

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// trimRunes 按字符（不是字节）截断，避免把一个中文字切成两半。
func trimRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
