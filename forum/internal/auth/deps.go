package auth

import (
	"context"
	"net/netip"
	"strconv"
	"time"

	"forum/internal/platform/queue"
)

// 本模块需要的外部能力，形状都取到最小。业务模块之间禁止互相 import（方案 §4），
// 这些接口由 app 层用别人的实现填（user / mail / captcha 模块）。
type (
	// UserLookup 由 internal/user.Service 实现。
	UserLookup interface {
		GetAuthRow(ctx context.Context, login string) (*UserAuthRow, error)
		GetBasic(ctx context.Context, userID int64) (UserBasic, error)
	}

	// MailAccounts 由 mail 的 Router 实现：判断「现在能不能发信」。
	// 这是注册与重发路径上的**同步**判定，不能等队列任务回报「发不出去」（拍板 §9.5）。
	// 额度满不算不可用（额度会恢复），所以它只回答「有没有可用账号」。
	MailAccounts interface {
		HasUsable(ctx context.Context) (bool, error)
	}

	// Mailer 由 mail 模块实现：建 mail_logs 行 + 入队 mail:send，返回 mail_log.id。
	// 业务代码不许直接发信（方案 §15.10）：本模块只交「收件人 + 模板 + 6 位码」。
	// 模板 id 照 0014_mail 的 ck_mail_logs_template：verify_email / reset_password。
	Mailer interface {
		SendVerifyCode(ctx context.Context, userID int64, to, code, template string) (int64, error)
	}

	// Captcha 由 captcha 模块实现。captcha.mode=off 时 app 层传 nil，本模块跳过校验。
	Captcha interface {
		Verify(ctx context.Context, id, answer string) (bool, error)
	}

	// Limiter 是 platform/ratelimit.RateLimiter 的子集。
	Limiter interface {
		Allow(ctx context.Context, key string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error)
	}

	// Queue 是 platform/queue.Queue 的入队侧。任务类型常量在 platform/queue 一处定义。
	Queue interface {
		Enqueue(ctx context.Context, t queue.Task) error
	}
)

// 两个邮件模板 id（与 mail_logs 的 CHECK 逐字一致）。
const (
	TemplateVerifyEmail = "verify_email"
	TemplateResetCode   = "reset_password"
)

// UserAuthRow 是登录判定需要的列，**不含权限集合**——权限由 pgsql.LoadActor 单独算（设计 §8.3）。
type UserAuthRow struct {
	ID              int64
	PublicID        string
	Username        string
	Email           string
	PasswordHash    string
	Nickname        string
	Status          string
	EmailVerifiedAt *time.Time
	ActivatedAt     *time.Time
	Trusted         bool
	RoleID          int64
	RoleKey         string
	IsSuper         bool
}

// UserBasic 是会话解析时顺带要的用户展示字段。
type UserBasic struct {
	ID          int64
	PublicID    string
	Handle      string
	Nickname    string
	AvatarHash  string
	AvatarSmall string
	Status      string
}

// enqueueMail 入队一条发信任务。payload 形状由 mail 模块定（mail:send 按 id 找 mail_logs 行）。
func enqueueMail(ctx context.Context, q Queue, sendID int64) error {
	return q.Enqueue(ctx, queue.Task{
		Type:    queue.TypeMailSend,
		Payload: map[string]int64{"id": sendID},
		// 幂等键 = mail_logs.id：唯一索引保证同一封邮件不会被入队两次。
		UniqueKey: "mail:" + strconv.FormatInt(sendID, 10),
	})
}

// ipString 把 netip.Addr 变成入库用的文本（audit_logs.ip / sessions.ip）。
func ipString(a netip.Addr) string {
	if !a.IsValid() {
		return ""
	}
	return a.String()
}
