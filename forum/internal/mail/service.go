// Package mail 是发信域：发信账号（凭据加密）、每日额度账、mail_logs 与 mail:send 任务。
//
// 分层（d6 §0）：platform/mail 是技术件（provider / Router / 加解密 / 模板），本包是业务
// （状态机、mail.enabled、任务循环、后台 CRUD）。两边不构成环。
//
// 额度占用的粒度是**一次投递**，不是一次尝试：占额度的动作只在 Router 里发生一次，
// 结果写回 mail_logs.quota_account_id / quota_day；重试先看 quota_day 命中就复用（d6 §2.5）。
package mail

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/mail/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	"forum/internal/platform/clock"
	pgmail "forum/internal/platform/mail"

	"github.com/jackc/pgx/v5/pgconn"
)

// Service 是发信域的全部业务逻辑。actor 由 handler 显式传入（拍板 §5.3），不从 context 取。
type Service struct {
	db *ent.Client
	pg *pgsql.Queries
	// Crypter 是发信凭据的加解密器（chacha20poly1305）。导出是因为 AI 审核的 API Key 与发信凭据
	// **同一把主密钥、同一套机制**（d7 §2.1）：主密钥只有一把，不为 AI 再引一把。
	// nil = 主密钥不可用：HasUsable 恒 false，Send 返回 ErrPermanent。
	Crypter *pgmail.Crypter
	q       Queue
	set     Settings
	audit   *audit.Writer
	clk     clock.Clock
	log     *slog.Logger
}

// NewService 的签名就是接线契约：db / 主密钥 / 队列 / 站点设置 / 审计 / 时钟 / 日志。
//
// 主密钥不合法（缺失、不是 32 字节 hex）**不 panic、也不拒绝启动**：发信能力必须是一件
// **可判定**的事（拍板 §12.2）—— HasUsable 返回 false，注册路径据此回 503
// auth.mail_unavailable，而不是让运维在启动日志里找原因。
func NewService(db *ent.Client, keys Keys, q Queue, set Settings, a *audit.Writer, clk clock.Clock, log *slog.Logger) *Service {
	s := &Service{
		db: db, pg: pgsql.New(db), q: q, set: set,
		audit: a, clk: clk, log: log,
	}
	crypt, err := pgmail.NewCrypter(keys.KeyHex, oldKeys(keys.OldKeysHex)...)
	if err != nil {
		s.log.Warn("mail: 主密钥不可用，发信功能关闭（配好 FORUM_MAIL__KEY 后重启即可）", "err", err.Error())
	} else {
		s.Crypter = crypt
	}
	return s
}

// oldKeys 把逗号分隔的旧密钥串切开；空串切出空切片。
func oldKeys(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return strings.Split(s, ",")
}

// HasUsable 回答「现在有没有可用发信账号」—— auth 的 MailAccounts 接口要的就是它（拍板 §12.2）。
//
// 它是注册与重发路径上的**同步**判定：auto_activate=true 却没有可用账号 → 注册 503 并回滚。
// 判定与 platform/mail.Router 的取账号逻辑同源：可用 = enabled + 未归档 + 凭据能解开 + reset_tz 合法。
// **额度满不算不可用**：额度会恢复，那是「今天发不出去」，不是「发信系统坏了」。
func (s *Service) HasUsable(ctx context.Context) (bool, error) {
	if s.Crypter == nil {
		return false, nil // 没有主密钥 = 一封信都发不出去
	}
	rows, err := s.pg.Candidates(ctx)
	if err != nil {
		return false, err
	}
	for _, c := range rows {
		if _, err := s.Crypter.Decrypt(c.Cipher, c.Nonce, []byte(c.PublicID)); err != nil {
			continue
		}
		if _, err := loadTZ(c.ResetTZ); err != nil {
			continue // reset_tz 坏了 Router 也会跳过它（额度按自然日算，算不出日子就发不了）
		}
		return true, nil
	}
	return false, nil
}

// enabled 读站点总开关。没有 site 实现时按开启处理：关站是显式动作，缺实现不该把发信锁死。
func (s *Service) enabled(ctx context.Context) bool {
	return s.set == nil || s.set.SettingBool(ctx, settingEnabled)
}

// siteName 是邮件落款用的站名（每次投递现取：改站名之后旧邮件也用新名字）。
func (s *Service) siteName(ctx context.Context) string {
	if s.set == nil {
		return ""
	}
	return s.set.Setting(ctx, settingSiteName)
}

// requirePerm 是队列 / CLI 也会走到的兜底判定（不走路由也挡住）。
func requirePerm(actor *authz.Actor, perm string) error {
	if actor == nil || actor.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	if !actor.IsSuper && !actor.Perms.Has(perm) {
		return apperr.ErrForbidden
	}
	return nil
}

func isNotFound(err error) bool { return ent.IsNotFound(err) }

// isUniqueViolation 收口唯一索引冲突（幂等键、账号名）。
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}

// checkEnqueue 是入队前的信任边界校验：模板必须是四个之一、收件人非空、幂等键必填。
// 这些值是我们自己（或 auth）写的，错了就是代码 bug —— 用普通 error 报出来，别伪装成 400。
func checkEnqueue(in EnqueueInput) error {
	switch in.Template {
	case TemplateVerifyEmail, TemplateResetPassword, TemplateTest, TemplateNotice:
	default:
		return fmt.Errorf("mail: 不认识的模板 %q", in.Template)
	}
	if in.ToAddress == "" {
		return fmt.Errorf("mail: 收件人为空（模板 %s）", in.Template)
	}
	if in.IdempotencyKey == "" {
		return errors.New("mail: 幂等键必填（uq_mail_logs_idem 是重试与重复提交的支点）")
	}
	return nil
}
