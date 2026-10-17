package mail

import (
	"context"
	"database/sql"
	"log/slog"
	"strings"
	"sync"
	"time"

	"forum/internal/authz"
	"forum/internal/mail/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	pgmail "forum/internal/platform/mail"
)

// templateKinds 是后台列表的固定次序（与 types.go 的四个常量、CHECK 值域一致）。
var templateKinds = []string{TemplateVerifyEmail, TemplateResetPassword, TemplateTest, TemplateNotice}

// ---- 缓存 ----

// templateCache 是自定义模板的进程内读缓存：投递前 Get 落库里查一次，编译结果留内存；
// PutTemplate / DeleteTemplate 之后 Invalidate —— admin 请求与 mail:send 任务消费的是**同一个**
// *Service（app 层单实例装配，见 app/modules.go），所以「同进程内 PUT 通知失效」是确定的。
//
// 取舍（派单要求写清）：失效只靠进程内这一个真源 —— dev/prod 都是单实例，跨实例没有别的读侧；
// 将来真上多实例，路只有「共享失效信号」或「读侧 TTL」，单实例下不做这个。
// 库里躺着一份编不过的模板（只有绕过 PUT 手改库才可能发生）时不缓存：每封投递 Warn 一次并回落内置。
type templateCache struct {
	pg  *pgsql.Queries
	log *slog.Logger

	mu   sync.RWMutex
	tpl  map[string]*pgmail.Compiled // 已编译的自定义模板
	skip map[string]bool             // 查过且库里没有：不再读库，恒回落内置
}

func newTemplateCache(pg *pgsql.Queries, log *slog.Logger) *templateCache {
	return &templateCache{pg: pg, log: log, tpl: map[string]*pgmail.Compiled{}, skip: map[string]bool{}}
}

// Get 返回该 kind 的编译产物；nil = 内置（库里没有，或者是手改库造成的编译失败）。
func (c *templateCache) Get(ctx context.Context, kind string) (*pgmail.Compiled, error) {
	c.mu.RLock()
	if v, ok := c.tpl[kind]; ok {
		c.mu.RUnlock()
		return v, nil
	}
	if c.skip[kind] {
		c.mu.RUnlock()
		return nil, nil
	}
	c.mu.RUnlock()

	row, err := c.pg.Template(ctx, kind)
	if err == nil {
		cv, cerr := pgmail.CompileTemplate(kind, pgmail.Override{Subject: row.Subject, HTMLBody: row.HTMLBody, TextBody: row.TextBody})
		if cerr != nil {
			// PUT 保存前编译校验过；能走到这里 = 库被手工改过。不缓存（下一封再试），这封回落内置。
			c.log.Warn("mail: 自定义模板编译失败（库被手工改过？），本封回落内置", "kind", kind, "err", cerr.Error())
			return nil, nil
		}
		c.mu.Lock()
		delete(c.skip, kind)
		c.tpl[kind] = cv
		c.mu.Unlock()
		return cv, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	c.mu.Lock()
	c.skip[kind] = true
	c.mu.Unlock()
	return nil, nil
}

// Invalidate 丢掉一个 kind 的两份记忆：写路径（PUT / DELETE）成功落库后调用。
func (c *templateCache) Invalidate(kind string) {
	c.mu.Lock()
	delete(c.tpl, kind)
	delete(c.skip, kind)
	c.mu.Unlock()
}

// ---- DTO ----

// TemplateInput 是 PUT 的入参：三段**模板源**一起给（不做部分保存的半截行）。
type TemplateInput struct {
	Subject  string `json:"subject" binding:"required,max=200"`
	HTMLBody string `json:"html_body" binding:"required,max=50000"`
	TextBody string `json:"text_body" binding:"required,max=50000"`
}

// TemplateView 是列表示例行：custom=false 时三段源就是**内置**的（编辑框填现状，不是空框）。
type TemplateView struct {
	Kind      string     `json:"kind"`
	Custom    bool       `json:"custom"`
	Subject   string     `json:"subject"`
	HTMLBody  string     `json:"html_body"`
	TextBody  string     `json:"text_body"`
	UpdatedAt *time.Time `json:"updated_at"`
	UpdatedBy *int64     `json:"updated_by"`
}

// TemplatePreview 是预览回执：三份都是**渲染后**的（HTML 已按模板语义转义）。
type TemplatePreview struct {
	Subject string `json:"subject"`
	Text    string `json:"text"`
	HTML    string `json:"html"`
}

// ListTemplates 后台模板列表：缺行回落内置源（编辑框先填现状），custom 标记「内置还是自定义」。
func (s *Service) ListTemplates(ctx context.Context, actor *authz.Actor) ([]TemplateView, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	rows, err := s.pg.Templates(ctx)
	if err != nil {
		return nil, err
	}
	byKind := make(map[string]pgsql.TemplateRow, len(rows))
	for _, r := range rows {
		byKind[r.Kind] = r
	}
	out := make([]TemplateView, 0, 4)
	for _, kind := range templateKinds {
		if r, ok := byKind[kind]; ok {
			by := r.UpdatedAt.UnixMicro()
			out = append(out, TemplateView{
				Kind: kind, Custom: true, Subject: r.Subject, HTMLBody: r.HTMLBody, TextBody: r.TextBody,
				UpdatedAt: &r.UpdatedAt, UpdatedBy: &by,
			})
			continue
		}
		builtin, berr := pgmail.Builtin(kind)
		if berr != nil {
			return nil, berr
		}
		out = append(out, TemplateView{Kind: kind, Subject: builtin.Subject, HTMLBody: builtin.HTMLBody, TextBody: builtin.TextBody})
	}
	return out, nil
}

// PutTemplate 保存一份自定义模板。**保存前编译**：语法错 / 缺尾块 / 字段不存在都在这里
// 拒收（400，错误原话按段拆回字段），不许存一个会炸的模板 —— 否则炸在投递时就是 500。
func (s *Service) PutTemplate(ctx context.Context, actor *authz.Actor, kind string, in TemplateInput, ip string) (*TemplateView, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	if err := knownTemplate(kind); err != nil {
		return nil, err
	}
	if _, err := pgmail.CompileTemplate(kind, pgmail.Override{Subject: in.Subject, HTMLBody: in.HTMLBody, TextBody: in.TextBody}); err != nil {
		return nil, compileFields(kind, err)
	}
	now := s.clk.Now()
	if err := s.pg.UpsertTemplate(ctx, kind, in.Subject, in.HTMLBody, in.TextBody, actor.UserID, now); err != nil {
		return nil, err
	}
	s.tpl.Invalidate(kind)
	if err := s.audit.Write(ctx, nil, audit.Entry{
		ActorID: actor.UserID, Action: actionTemplateUpdate,
		TargetType: "mail_template", TargetID: kind, IP: ip,
		Detail: map[string]any{"after": map[string]any{"subject": in.Subject, "html_bytes": len(in.HTMLBody), "text_bytes": len(in.TextBody)}},
	}); err != nil {
		return nil, err
	}
	return &TemplateView{
		Kind: kind, Custom: true, Subject: in.Subject, HTMLBody: in.HTMLBody, TextBody: in.TextBody,
		UpdatedAt: &now, UpdatedBy: &actor.UserID,
	}, nil
}

// DeleteTemplate 恢复内置：删行（缺行也幂等）→ 缓存失效 → 下一次渲染落回 embed。
func (s *Service) DeleteTemplate(ctx context.Context, actor *authz.Actor, kind string, ip string) (*TemplateView, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	if err := knownTemplate(kind); err != nil {
		return nil, err
	}
	if err := s.pg.DeleteTemplate(ctx, kind); err != nil {
		return nil, err
	}
	s.tpl.Invalidate(kind)
	if err := s.audit.Write(ctx, nil, audit.Entry{
		ActorID: actor.UserID, Action: actionTemplateReset,
		TargetType: "mail_template", TargetID: kind, IP: ip,
	}); err != nil {
		return nil, err
	}
	builtin, berr := pgmail.Builtin(kind)
	if berr != nil {
		return nil, berr
	}
	return &TemplateView{Kind: kind, Subject: builtin.Subject, HTMLBody: builtin.HTMLBody, TextBody: builtin.TextBody}, nil
}

// PreviewTemplate 用样本 Data 把「编辑框里还没保存的那份」实渲染一遍（三段可选：空的段回落内置）。
// 样本昵称特意带尖括号与 <script>：转义是否成立，预览就要看得见，不留到投递。
func (s *Service) PreviewTemplate(ctx context.Context, actor *authz.Actor, kind string, in *TemplateInput) (*TemplatePreview, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	if err := knownTemplate(kind); err != nil {
		return nil, err
	}
	ov := pgmail.Override{}
	if in != nil {
		ov = pgmail.Override{Subject: in.Subject, HTMLBody: in.HTMLBody, TextBody: in.TextBody}
	}
	c, err := pgmail.CompileTemplate(kind, ov)
	if err != nil {
		return nil, compileFields(kind, err)
	}
	sample := pgmail.Data{
		SiteName:  s.siteName(ctx),
		Nickname:  "爱<>(如:<script>alert(1)</script>",
		Code:      "123456",
		ExpiresIn: "10 分钟",
		Title:     "你关注的帖子有了新回复",
		Body:      "你关注的《示例帖》有了新回复，点开看看。",
		Link:      "https://example.com/t/1",
		From:      "no-reply@example.com",
		Now:       s.clk.Now().Format("2006-01-02 15:04"),
	}
	msg, err := c.Render(sample)
	if err != nil {
		return nil, err
	}
	return &TemplatePreview{Subject: msg.Subject, Text: msg.Text, HTML: msg.HTML}, nil
}

// knownTemplate 把 kind 卡在四个字面值上（与 mail_logs.template 的 CHECK 逐字一致）。
func knownTemplate(kind string) error {
	switch kind {
	case TemplateVerifyEmail, TemplateResetPassword, TemplateTest, TemplateNotice:
		return nil
	default:
		return apperr.Invalid(map[string]string{"kind": "不认识的模板，值域 verify_email / reset_password / test / notice"})
	}
}

// compileFields 把编译错误按**段**拆回字段（html_body / text_body / subject）——
// 错误原话里带着 template: <kind>:<段>:<行>:，前端把它对到编辑框旁边就地显示。
func compileFields(kind string, err error) error {
	msg := err.Error()
	fields := map[string]string{}
	switch {
	case strings.Contains(msg, kind+":subject"):
		fields["subject"] = msg
	case strings.Contains(msg, kind+":html"):
		fields["html_body"] = msg
	case strings.Contains(msg, kind+":text"):
		fields["text_body"] = msg
	default:
		fields["_"] = msg
	}
	return apperr.Invalid(fields)
}
