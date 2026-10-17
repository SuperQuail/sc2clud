package appeal

import "time"

// ── 出参 ──────────────────────────────────────────────────────────────────────
//
// 字段名即契约（前端 web/src/lib/api/social.ts 照抄这里）。
// **自增 bigint 不出现在响应里**：外面看到的标识是 no（对外单号）与 public_id。

// Appeal 是一条申诉的对外形态。
type Appeal struct {
	// No 是对外单号（AP-2001 这种）。它同时是免登录查进展的凭据之一，所以可读、不可枚举。
	No       string `json:"no"`
	Type     string `json:"type"`
	Username string `json:"username"`
	Email    string `json:"email"`
	// UserID 是自证通过后绑上的账号（公开 id）；验不过时为 null —— 那不是「没有这个人」，
	// 是「这条要人眼核一下」（identity_verified=false）。
	UserID *string `json:"user_id"`
	// IdentityVerified = 用户存在 **且** 提交的邮箱与账号注册邮箱一致。管理员队列靠它分「可信/要核」两档。
	IdentityVerified bool `json:"identity_verified"`
	// TopicID 只有 review_reject 有（那篇被驳回的帖子）。
	TopicID *string `json:"topic_id"`
	// TopicReviewState 是那篇帖子**此刻**的审核态（app 层注入的读口）：作者申诉之后
	// 「我这帖现在算过还是没过」要能一眼看到，而不是只有一条申诉记录。
	TopicReviewState *string `json:"topic_review_state"`
	Ref              string  `json:"ref"`
	Title            string  `json:"title"`
	Details          string  `json:"details"`
	Contact          string  `json:"contact"`
	Status           string  `json:"status"`
	Decision         *string `json:"decision"`
	// Response 是给提交人看的答复（status 离开 pending 时必填，0022 的 ck_appeals_handled 兜着）。
	Response   string     `json:"response"`
	HandleNote string     `json:"handle_note"`
	Handler    *UserBrief `json:"handler"`
	HandledAt  *time.Time `json:"handled_at"`
	Eta        string     `json:"eta"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// UserBrief 是账号的最小画像：管理端队列上的处理人，以及 C5 落库时要的用户名与注册邮箱。
// Email 只在本域内部用（C5 的 appeals.email 是 NOT NULL），**不出现在出参里** ——
// 队列上展示别人的邮箱是多余的信息暴露。
type UserBrief struct {
	Handle   string `json:"handle"`
	Nickname string `json:"nickname"`
	Email    string `json:"-"`
}

// SubmitResult 是 POST /appeals 与 C5 的回执。
//
// Created=false 表示复用了既有那条（C5 的幂等重放）：handler 据此回 200 而不是 202。
// 前端两种都当成功 —— 用户的目的（「我申诉了」）已经达成。
type SubmitResult struct {
	No      string `json:"no"`
	Eta     string `json:"eta"`
	Status  string `json:"status"`
	Created bool   `json:"created"`
}

// Page 是一页（{ data, next_cursor }）。
type Page struct {
	Items      []Appeal
	NextCursor string
}

// ── 入参 ──────────────────────────────────────────────────────────────────────

// CreateInput 是 POST /appeals 的请求体。
//
// **字段名就是 web/src/routes/appeal.tsx 已经在发的那些**，一个字都不改：
// 那是前端已经上线的形状，本域去适配它，不是让它来适配本域。
type CreateInput struct {
	Type     string `json:"type" binding:"required,oneof=ban review_reject report_result other"`
	Username string `json:"username" binding:"max=64"`
	Email    string `json:"email" binding:"required,email,max=254"`
	Ref      string `json:"ref" binding:"max=200"`
	Title    string `json:"title" binding:"required,max=120"`
	Details  string `json:"details" binding:"required,max=4000"`
	Contact  string `json:"contact" binding:"max=200"`

	// 图形验证码两段。**为什么两段都收**（而不是只收答案）：
	// platform/captcha 的 Verify(id, answer) 要 id 才能定位那道题；
	// routes/appeal.tsx 现在只发答案（它的 ProductCaptcha 有 onChallenge 回调但没接上），
	// 而「填了验证码却提交不了」比验证码本身更糟。所以 Id 可缺：缺了按「这道题不存在」判错，
	// 答错与过期对外是同一个码（captcha.ErrWrong 的既定约定），文案指向「换一张」。
	CaptchaID     string `json:"captcha_id" binding:"max=64"`
	CaptchaAnswer string `json:"captcha" binding:"max=16"`

	// IP 由 handler 填（不在请求体里）：限流与审计要用，客户端不能自称。
	IP string `json:"-"`
}

// ReviewAppealInput 是 C5 的请求体（POST /topics/{id}/review/appeal）。
type ReviewAppealInput struct {
	Reason string `json:"reason" binding:"max=2000"`
}

// LookupInput 是免登录查进展的入参（POST /appeals/lookup）。
// 用 POST 而不是 GET：单号 + 邮箱是凭据，不该出现在 URL、访问日志与浏览器历史里。
type LookupInput struct {
	No    string `json:"no" binding:"required,max=16"`
	Email string `json:"email" binding:"required,email,max=254"`
}

// QueueInput 是管理端队列的筛选（GET /admin/appeals）。
type QueueInput struct {
	Status string `json:"status" form:"status" binding:"omitempty,oneof=pending replied closed"`
	Type   string `json:"type" form:"type" binding:"omitempty,oneof=ban review_reject report_result other"`
	Q      string `json:"q" form:"q" binding:"max=100"`
	Limit  int    `json:"limit" form:"limit"`
	Cursor string `json:"cursor" form:"cursor"`
}

// DecideInput 是处理一条申诉（POST /admin/appeals/{no}）。
//
// 判定顺序与 report 域一致：权限 → 读行（404）→ 已是终态（409）→ CAS（0 行再 409）→ 审计。
type DecideInput struct {
	// No 是申诉单号（AP-2001）。**放在请求体里而不是路径上**：路径上的
	// PUT /admin/appeals/:no 会与同层的 POST /admin/appeals 形成 gin 的通配冲突
	//（/admin 组里已有 /reports/:id，但那是另一个前缀）—— 单号本来就是「选哪一条」，
	// 不是资源的地址（对外标识是 no，内部标识是 public_id，两者都不该进 URL 的形状里）。
	No string `json:"no" binding:"required,max=16"`
	// Decision 必填：维持原处理 / 改判。设计稿的「已驳回」就是 upheld，不是第四个状态。
	Decision string `json:"decision" binding:"required,oneof=upheld overturned"`
	// Response 是给提交人的答复，**必填** —— 「处理了但不告诉他结果」正是本域要消灭的形态
	// （盲审二号：点完申诉界面不变，用户以为没点上）。
	Response string `json:"response" binding:"required,max=2000"`
	// Note 是给自己人看的内部备注（与 response 分开：一份给人看、一份给自己人看）。
	Note string `json:"note" binding:"max=500"`
	// Close=true 表示这条申诉到此为止（status=closed）；false 允许提交人补充材料（status=replied）。
	Close bool   `json:"close"`
	IP    string `json:"-"`
}

// MineInput 是「我的申诉」分页。
type MineInput struct {
	Limit  int    `json:"limit" form:"limit"`
	Cursor string `json:"cursor" form:"cursor"`
}
