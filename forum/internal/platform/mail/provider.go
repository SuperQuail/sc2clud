package mail

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/resend/resend-go/v3"
	"github.com/wneessen/go-mail"
)

// provider 按账号的 provider 列构造具体投递方式。
//
// 不做 d6 §5.1 里那个可注册的 Factory：本产品只有三个 provider，各自需要的依赖也不一样，
// 多一层注册表换不来任何东西。
func (r *Router) provider(a Account) (Provider, error) {
	switch a.Provider {
	case "log":
		return &logProvider{log: r.log, from: fromOf(a)}, nil
	case "resend":
		c, err := decodeCreds(a.Secret)
		if err != nil {
			return nil, err
		}
		if c.APIKey == "" {
			return nil, fmt.Errorf("%w: resend 账号 %s 的凭据缺 api_key", ErrPermanent, a.Name)
		}
		return &resendProvider{key: c.APIKey, from: fromOf(a)}, nil
	case "smtp":
		c, err := decodeCreds(a.Secret)
		if err != nil {
			return nil, err
		}
		cfg, err := smtpOptionsOf(a.Options)
		if err != nil {
			return nil, err
		}
		return &smtpProvider{cfg: cfg, creds: c, from: fromOf(a)}, nil
	}
	// 迁移的 CHECK 只允许这三个值；出现别的值说明数据被手工改过。
	return nil, fmt.Errorf("%w: 不认识的 provider %q（账号 %s）", ErrPermanent, a.Provider, a.Name)
}

// fromOf 拼发件人：有名字时用 RFC 5322 的 Name <addr> 形式。
func fromOf(a Account) string {
	if a.FromName == "" {
		return a.FromAddress
	}
	return fmt.Sprintf("%s <%s>", a.FromName, a.FromAddress)
}

// creds 是凭据明文的形状（整份 JSON 加密后存 mail_accounts.secret_cipher）。
type creds struct {
	APIKey   string `json:"api_key"`  // resend
	Username string `json:"username"` // smtp
	Password string `json:"password"` // smtp
}

func decodeCreds(secret []byte) (creds, error) {
	var c creds
	if len(secret) == 0 {
		return c, fmt.Errorf("%w: 账号没有凭据", ErrPermanent)
	}
	if err := json.Unmarshal(secret, &c); err != nil {
		return c, fmt.Errorf("%w: 凭据不是合法 JSON: %v", ErrPermanent, err)
	}
	return c, nil
}

// smtpOptions 是 options_json 里 smtp 专属的**非敏感**参数（明文，后台可直接展示）。
type smtpOptions struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	TLS         string `json:"tls"`          // starttls（默认）/ tls / none
	InsecureTLS bool   `json:"insecure_tls"` // 只给自建的测试 SMTP 服务器用
}

func smtpOptionsOf(raw json.RawMessage) (smtpOptions, error) {
	var o smtpOptions
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &o); err != nil {
			return o, fmt.Errorf("%w: options_json 不是合法 JSON: %v", ErrPermanent, err)
		}
	}
	if o.Host == "" {
		return o, fmt.Errorf("%w: smtp 账号缺 options_json.host", ErrPermanent)
	}
	if o.Port == 0 {
		o.Port = 587
	}
	switch o.TLS {
	case "", "starttls", "tls", "none":
	default:
		return o, fmt.Errorf("%w: options_json.tls 只能是 starttls / tls / none，实际 %q", ErrPermanent, o.TLS)
	}
	return o, nil
}

// logProvider 把整封信（含正文全文）写进 slog。
//
// 它让「注册 → 收码 → 激活」在零外部依赖下可跑（拍板 §12.6 的验收要的正是这条）。
//
// 【安全】正文里有 6 位验证码，等同密码：**只能配在 dev / 测试环境**。
// 生产库里出现 provider='log' 的账号 = 把验证码写进日志。
type logProvider struct {
	log  *slog.Logger
	from string
}

func (p *logProvider) Send(_ context.Context, m Message) error {
	p.log.Info("mail: log provider 投递（仅 dev/测试）",
		"from", p.from, "to", m.To, "subject", m.Subject,
		"html", m.HTML, "text", m.Text)
	return nil
}

// resendProvider 走 Resend 的 HTTP API（主力提供商）。
type resendProvider struct {
	key  string
	from string
}

func (p *resendProvider) Send(ctx context.Context, m Message) error {
	client := resend.NewClient(p.key)
	_, err := client.Emails.SendWithContext(ctx, &resend.SendEmailRequest{
		From: p.from, To: []string{m.To}, Subject: m.Subject, Html: m.HTML, Text: m.Text,
	})
	if err != nil {
		return classifyResend(err)
	}
	return nil
}

// classifyResend 只补 Resend SDK 能判定的两类，其余交给 Classify。
//
// 该 SDK 对 400/422 返回的是 `errors.New("[ERROR]: ...")`（没有类型），所以只能按前缀认；
// 这个形状不稳定，认不出来时 Classify 会落到「临时」——宁可重试，也不要把信永久丢掉。
func classifyResend(err error) error {
	var rl *resend.RateLimitError
	if errors.As(err, &rl) {
		return fmt.Errorf("%w: %v", ErrQuotaExceeded, err)
	}
	if strings.HasPrefix(err.Error(), "[ERROR]: ") {
		return fmt.Errorf("%w: %v", ErrPermanent, err)
	}
	return err
}

// smtpProvider 走通用 SMTP（Brevo / Mailgun / 自建都提供）。
type smtpProvider struct {
	cfg   smtpOptions
	creds creds
	from  string
}

func (p *smtpProvider) Send(ctx context.Context, m Message) error {
	opts := []mail.Option{mail.WithPort(p.cfg.Port)}
	switch p.cfg.TLS {
	case "tls":
		opts = append(opts, mail.WithSSL())
	case "none":
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
	default:
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	}
	if p.creds.Username != "" {
		opts = append(opts, mail.WithSMTPAuth(mail.SMTPAuthPlain),
			mail.WithUsername(p.creds.Username), mail.WithPassword(p.creds.Password))
	}
	if p.cfg.InsecureTLS {
		// 显式配置项，不静默降级：只有自建测试服务器才会打开它。
		opts = append(opts, mail.WithTLSConfig(&tls.Config{InsecureSkipVerify: true})) // #nosec G402
	}

	c, err := mail.NewClient(p.cfg.Host, opts...)
	if err != nil {
		return fmt.Errorf("smtp: 建客户端: %w", err)
	}
	msg := mail.NewMsg()
	if err := msg.From(p.from); err != nil {
		return fmt.Errorf("%w: smtp 发件人: %v", ErrPermanent, err)
	}
	if err := msg.To(m.To); err != nil {
		return fmt.Errorf("%w: smtp 收件人: %v", ErrPermanent, err)
	}
	msg.Subject(m.Subject)
	msg.SetBodyString(mail.TypeTextPlain, m.Text)
	msg.AddAlternativeString(mail.TypeTextHTML, m.HTML)

	// 超时放在 Send 上：go-mail 会把它带到 SMTP 的每一步（连不上时不能挂到天荒地老）。
	sendCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := c.DialAndSendWithContext(sendCtx, msg); err != nil {
		return classifySMTP(err)
	}
	return nil
}

// classifySMTP 用 go-mail 自己的投递错误判定，而不是自己去解析应答码文本。
//
// go-mail 在 SendError 里已经算好了「这条错误能不能重试」（它的 isTemp 按 SMTP 应答码定：
// 4xx 临时、5xx 永久），再按码表写一遍是**两处各写一遍同一个事实**，迟早漂。
// 只有 429 是例外：它语义上属于「这个账号今天到头了」，要触发换账号而不是无脑退避。
func classifySMTP(err error) error {
	var se *mail.SendError
	if errors.As(err, &se) {
		if se.ErrorCode() == 429 {
			return fmt.Errorf("%w: %v", ErrQuotaExceeded, err)
		}
		if se.IsTemp() {
			return fmt.Errorf("%w: %v", ErrTemporary, err)
		}
		return fmt.Errorf("%w: %v", ErrPermanent, err)
	}
	return err
}
