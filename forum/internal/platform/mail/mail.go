// Package mail 是发信的技术件：provider、多账号轮换（Router）、凭据加解密、模板。
//
// 分层（d6-reward §0）：
//   - 本包**不含业务**：mail_logs 的状态机、site_settings.mail.enabled、mail:send 任务的循环
//     都在 internal/mail（业务模块）里；本包只做「选账号 + 占额度 + 发出去 + 记健康」。
//   - 本包可以 import internal/ent（v2 §4.2 第 2 条），因为它要读 mail_accounts / mail_quota；
//     反过来 internal/mail 可以 import 本包，两边不构成环。
//   - 凭据只从 mail_accounts.secret_cipher 解密得到，主密钥只从环境变量来（v2 §8.7）。
package mail

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"syscall"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/clock"
)

// Message 是一封要发出去的信。业务侧只填 To/Subject/HTML/Text。
type Message struct {
	To      string
	Subject string
	HTML    string
	Text    string
}

// Provider 是一种投递方式（resend / smtp / log）。
//
// 不返回 provider 侧的 message id：本产品的幂等支点是 mail_logs.idempotency_key，
// 而 SMTP 没有幂等键、Resend 返回的 id 也没人查（少一个没人用的返回值）。
type Provider interface {
	Send(ctx context.Context, m Message) error
}

// Sender 是业务侧唯一认的东西：投递一次。
// 它内部负责「复用已占额度 / 新占额度 / 失败换账号」，所以额度占用的粒度是**一次投递**。
type Sender interface {
	Send(ctx context.Context, m Message, opts ...SendOption) error
}

// SendOption 调整一次 Send 的行为。只有一个选项：把上次投递已经占住的额度带进来，
// 否则重试会**再占一次**（额度账只看得到「今天这个账号被占过」，认不出「是同一封信占的」）。
type SendOption func(*sendOpts)

type sendOpts struct {
	hold *Hold
}

// Hold 是一次已经占住的额度：投递记录里的 quota_account_id + quota_day。
type Hold struct {
	AccountID int64
	Day       time.Time
}

// WithHeld 告诉 Send「这封信上次已经占住了这个账号这一天的额度」，先复用它。
// 调用方（internal/mail 的 mail:send 处理函数）负责判定这个 Hold 是否还属于今天。
func WithHeld(h Hold) SendOption {
	return func(o *sendOpts) { o.hold = &h }
}

// 三类可判定的失败。provider 实现必须用 Classify 把原始错误包成其中之一——
// Router 靠它们决定「换账号 / 熔断 / 直接放弃」。
var (
	ErrQuotaExceeded = errors.New("mail: provider quota exceeded")
	ErrTemporary     = errors.New("mail: temporary failure")
	ErrPermanent     = errors.New("mail: permanent failure")
	// ErrNoProvider 表示「当前没有任何可用账号」：全被排除 / 全部解不开凭据。
	// 调用方据此把任务排到下一个额度重置点（d6 §6.11）。
	ErrNoProvider = errors.New("mail: no usable account")
)

// held 标记这次投递用的是哪个账号的哪一天额度，以及额度是不是本次新占的。
// 只有 new 为 true 时调用方才需要把它写回投递记录（quota_account_id, quota_day）。
type held struct {
	id  int64
	day string
	new bool
}

// Store 是 Router 写回业务表的最小面（由 internal/mail 实现；本包不认识 mail_logs 的状态机）。
type Store interface {
	// BindQuota 把本次新占的额度写回投递记录；复用旧额度时不会被调用。
	BindQuota(ctx context.Context, accountID int64, day string) error
	// Report 记录这次投递的健康状态：成功写 last_ok_at，失败写 last_error / last_error_at。
	Report(ctx context.Context, accountID int64, err error) error
}

// Dependencies 是 Router 的外部依赖。
type Dependencies struct {
	DB *ent.Client
	// Crypter 为空时 NewRouter 自己从 `KeyEnv / KeyEnvOld` 建。
	Crypter *Crypter
	Store   Store
	Clock   clock.Clock
	Log     *slog.Logger
	// CacheTTL 是账号列表（含解密后的凭据）在内存里的存活时间（d6 §8.2，30 秒）。
	CacheTTL time.Duration
}

// Classify 把 provider 的原始错误归到三类之一（原始错误用 %w 包住，日志里还看得到）。
//
// 判定用的是错因本身：**认证失败 / 收件人不存在 / 域名被拒 = 永久**，
// **网络 / 超时 / 5xx = 临时**，**429 与「额度用尽」= 额度超限**。
func Classify(err error) error {
	if err == nil {
		return nil
	}
	for _, e := range []error{ErrQuotaExceeded, ErrTemporary, ErrPermanent} {
		if errors.Is(err, e) {
			return err // 已经分类过，别包第二层
		}
	}
	var he *httpError
	if errors.As(err, &he) {
		switch {
		case he.code == 429:
			return fmt.Errorf("%w: %v", ErrQuotaExceeded, err)
		case he.code >= 500:
			return fmt.Errorf("%w: %v", ErrTemporary, err)
		default:
			return fmt.Errorf("%w: %v", ErrPermanent, err)
		}
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return fmt.Errorf("%w: %v", ErrTemporary, err)
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) ||
		errors.Is(err, io.EOF) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) {
		return fmt.Errorf("%w: %v", ErrTemporary, err)
	}
	// 认不出来的错误按临时处理：宁可重试，也不要因为一个没见过的措辞把信永久丢掉。
	return fmt.Errorf("%w: %v", ErrTemporary, err)
}

// httpError 是 provider 返回 HTTP 状态码时的统一形状。
type httpError struct {
	code int
	body string
}

func (e *httpError) Error() string { return fmt.Sprintf("http %d: %s", e.code, e.body) }

var (
	_ Provider = (*resendProvider)(nil)
	_ Provider = (*smtpProvider)(nil)
	_ Provider = (*logProvider)(nil)
)
