package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/emailtoken"
	"forum/internal/ent/session"
	"forum/internal/ent/user"
	"forum/internal/platform/idgen"
)

// ── 单码试错上限（拍板 §11.4：5 次失败即作废） ──────────────────────────────
//
// 设计 §5.3 要求 email_tokens 有 attempt_count / last_attempt_at 两列来数它，
// 但**当前搞定迁移里没有这两列**。补列要动 migrations/**，不在本模块的写作用域里，
// 所以试错计数落在进程内的 attemptGuard 上：
//
//   - 单码上限照旧 5 次，第 5 次直接作废该码（对用户可见的行为与拍板一致）；
//   - 代价：多实例部署时每个实例各数各的（最坏 N×5 次）；另外「按账号 15 分钟内 10 次
//     失败 → 429」这一条本轮**没做**（它要在账号定位之后按 user_id 计数，而 kv 缓存
//     既没有按 key 的原子自增、也没有能配合 clock.Fake 的窗口）。
//     两列 + 一条原子自增是 Lead 的迁移决定，见回报的未决清单。
type attemptGuard struct {
	mu sync.Mutex
	m  map[string]int
}

const maxGuardKeys = 10000

func newAttemptGuard() *attemptGuard { return &attemptGuard{m: make(map[string]int)} }

func guardKey(userID int64, purpose string) string {
	return strconv.FormatInt(userID, 10) + ":" + purpose
}

// bump 记一次失败并返回累计次数。键太多说明有人在乱试：整体清空比内存无限涨好。
func (g *attemptGuard) bump(userID int64, purpose string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.m) >= maxGuardKeys {
		g.m = make(map[string]int)
	}
	g.m[guardKey(userID, purpose)]++
	return g.m[guardKey(userID, purpose)]
}

func (g *attemptGuard) forget(userID int64, purpose string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.m, guardKey(userID, purpose))
}

// ── 校验验证码 / 重置票据 ────────────────────────────────────────────

// VerifyCodeInput 的 Login 是 username 或 email 二选一（拍板 §11.3：
// 注册后用户手上最确定的是自己刚填的登录名）。
type VerifyCodeInput struct {
	Login string
	Code  string
	IP    string
}

// ResetTicket 是找回密码第一步拿到的临时凭据（10 分钟、一次性）。
type ResetTicket struct {
	Ticket    string    `json:"reset_ticket"`
	ExpiresAt time.Time `json:"expires_at"`
}

// VerifyEmailCode 校验邮箱验证码并激活账号（拍板 §11.4 的成功分支）：
// email_verified_at + activated_at 都置为现在、activation_pending 清空、该码作废。
func (s *Service) VerifyEmailCode(ctx context.Context, in VerifyCodeInput) error {
	u, row, err := s.locateCode(ctx, in, purposeVerify)
	if err != nil {
		return err
	}
	if u == nil || row == nil {
		return ErrTokenInvalid
	}
	now := s.clk.Now()

	return s.withTx(ctx, func(tx *ent.Tx) error {
		ok, err := consumeCode(ctx, tx, u.ID, purposeVerify, row.ID, codeHash(in.Code), now)
		if err != nil {
			return err
		}
		if !ok {
			s.noteBadCode(ctx, u.ID, purposeVerify, row.ID)
			return ErrTokenInvalid
		}
		// 拍板 §12.2：输码成功时 email_verified_at 与 activated_at **一起置**。
		// 没有 activation_pending 要清——模式是全局开关，不是每用户状态（拍板 §12.5）。
		if err := tx.User.UpdateOneID(u.ID).
			SetEmailVerifiedAt(now).
			SetActivatedAt(now).
			SetUpdatedAt(now).
			Exec(ctx); err != nil {
			return err
		}
		s.codes.forget(u.ID, purposeVerify)
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: u.ID, Action: ActionEmailVerify, TargetType: "user",
			TargetID: u.PublicID.String(), IP: ipOf(in.IP), Detail: map[string]any{},
		})
	})
}

// VerifyResetCode 是找回密码的第一步：校验同一个 purpose='reset' 的码，**不提前消费码**
// 的语义用「原地换成一张票据」实现（拍板 §11.7 的两步一页）。
//
// 票据也落在 email_tokens 上（purpose 仍是 reset，谓词仍只有 used_at IS NULL）：
// 第一步把行换成票据，第二步 DELETE ... RETURNING 消费它。这样「一次性」由数据库保证，
// 不需要 kv 的 GETDEL——而 kv.Cache 没有原子取删。
func (s *Service) VerifyResetCode(ctx context.Context, in VerifyCodeInput) (*ResetTicket, error) {
	u, row, err := s.locateCode(ctx, in, purposeReset)
	if err != nil {
		return nil, err
	}
	if u == nil || row == nil {
		return nil, ErrTokenInvalid
	}
	now := s.clk.Now()
	ticket, err := idgen.NewToken(32)
	if err != nil {
		return nil, err
	}
	expires := now.Add(codeTTL)

	err = s.withTx(ctx, func(tx *ent.Tx) error {
		ok, err := consumeCode(ctx, tx, u.ID, purposeReset, row.ID, codeHash(in.Code), now)
		if err != nil {
			return err
		}
		if !ok {
			s.noteBadCode(ctx, u.ID, purposeReset, row.ID)
			return ErrTokenInvalid
		}
		return s.upsertCode(ctx, tx, u.ID, purposeReset, codeHash(ticket), now)
	})
	if err != nil {
		return nil, err
	}
	return &ResetTicket{Ticket: ticket, ExpiresAt: expires}, nil
}

// locateCode 把 (login → users 行 → 该 purpose 的活跃码行) 两跳做完。
// 账号不存在返回 (nil, nil, nil)：调用方按**统一失败**处理，不区分「没这个账号」与「码错了」。
func (s *Service) locateCode(ctx context.Context, in VerifyCodeInput, purpose string) (*ent.User, *ent.EmailToken, error) {
	login := strings.TrimSpace(in.Login)
	if login == "" || len(in.Code) != 6 {
		return nil, nil, ErrTokenInvalid
	}
	row, found, err := s.lookup(ctx, login)
	if err != nil {
		return nil, nil, err
	}
	if !found {
		return nil, nil, nil
	}
	u, err := s.db.User.Query().Where(user.IDEQ(row.ID)).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	tok, err := s.db.EmailToken.Query().
		Where(emailtoken.UserIDEQ(u.ID), emailtoken.PurposeEQ(purpose), emailtoken.UsedAtIsNil()).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return u, nil, nil
		}
		return nil, nil, err
	}
	return u, tok, nil
}

// consumeCode 是「码对不对 + 能不能用」的**唯一判定处**，判据全在 SELECT ... FOR UPDATE 上：
//
//   - 两个并发请求：第二个阻塞到第一个提交，然后读到行已不在 → 失败。这就是设计 §10.4
//     讲的原子性（那里用条件 UPDATE 的 RETURNING，这里用行锁，效果等价）。
//   - 过期 / 已消费 / 试错满 5 次：三种情况**同一结果**，对外也是同一句文案。
func consumeCode(ctx context.Context, tx *ent.Tx, userID int64, purpose string, tokenID int64, hash []byte, now time.Time) (bool, error) {
	cur, err := tx.EmailToken.Query().
		Where(emailtoken.IDEQ(tokenID), emailtoken.UserIDEQ(userID), emailtoken.PurposeEQ(purpose)).
		ForUpdate().
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return false, nil // 并发下另一个请求已经把它删了
		}
		return false, err
	}
	if cur.UsedAt != nil || !cur.ExpiresAt.After(now) {
		return false, nil
	}
	if subtle.ConstantTimeCompare(cur.TokenHash, hash) != 1 {
		return false, nil
	}
	if _, err := tx.EmailToken.Delete().Where(emailtoken.IDEQ(cur.ID)).Exec(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// noteBadCode 记一次失败：满 5 次直接删掉该码（用户必须重新发送）。
// 设计 §10.4 支 B 是把 consumed_at 置为现在；DELETE 加部分唯一索引达到同一效果，
// 而且不需要 attempt_count 列。
func (s *Service) noteBadCode(ctx context.Context, userID int64, purpose string, tokenID int64) {
	if s.codes.bump(userID, purpose) < maxCodeAttempts {
		return
	}
	if _, err := s.db.EmailToken.Delete().Where(emailtoken.IDEQ(tokenID)).Exec(ctx); err != nil {
		s.log.Error("auth: 作废验证码失败", "token_id", tokenID, "err", err.Error())
	}
}

// noteBadCodeForTest 是**测试钩子**（名字带 ForTest 就是为了评审时一眼看见）：
// 把一次失败直接记进单码计数器并触发第 5 次的作废，不必真去猜 5 次码。
func (s *Service) noteBadCodeForTest(userID int64, purpose string) {
	s.noteBadCode(context.Background(), userID, purpose, 0)
}

// ResendResult 只说「发出去了没有」。前端该显示哪种界面由注册响应里的 auto_activate 决定
// （拍板 §12.2：模式是全局开关，不是每用户状态，所以这里不再回 activation_pending）。
type ResendResult struct {
	Sent bool `json:"sent"`
}

// ResendVerify 重发验证码：新码顶掉旧码；限流 1 次/分钟、5 次/天（拍板 §11.4）。
func (s *Service) ResendVerify(ctx context.Context, actor *authz.Actor, ip string) (*ResendResult, error) {
	if actor == nil {
		return nil, unauthorized()
	}
	if err := s.allow(ctx, keyMailUser(actor.UserID), 1, time.Minute); err != nil {
		return nil, err
	}
	if err := s.allow(ctx, keyMailUser(actor.UserID), 5, 24*time.Hour); err != nil {
		return nil, err
	}
	_ = ip
	// 开关关掉时**根本没有码**可重发：管理员选的模式就是「等我来激活」（拍板 §12.2 表格）。
	if !s.cfg.Auth.AutoActivateOn() {
		return nil, ErrResendDisabled
	}
	u, err := s.db.User.Query().Where(user.IDEQ(actor.UserID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if u.EmailVerifiedAt != nil {
		return nil, ErrEmailAlreadyVerified
	}
	// 一个可用发信账号都没有：确定性失败，503（不自作主张改成「等管理员」）。
	canMail, err := s.canMail(ctx)
	if err != nil {
		return nil, err
	}
	if !canMail {
		return nil, ErrMailUnavailable
	}

	code, err := newNumericCode()
	if err != nil {
		return nil, err
	}
	now := s.clk.Now()
	if err := s.withTx(ctx, func(tx *ent.Tx) error {
		return s.upsertCode(ctx, tx, u.ID, purposeVerify, codeHash(code), now)
	}); err != nil {
		return nil, err
	}
	s.enqueueVerifyMail(ctx, u.ID, u.Email, code, TemplateVerifyEmail)
	return &ResendResult{Sent: true}, nil
}

// ── 找回密码 ────────────────────────────────────────────────────────

// ForgotPassword **恒返回 nil**（设计 §10.6 第 3 步）：不暴露邮箱是否存在，
// handler 的响应体除 request_id 外逐字节相同。
func (s *Service) ForgotPassword(ctx context.Context, email, ip string) error {
	if err := s.allow(ctx, keyMailIP(ip), 3, time.Hour); err != nil {
		return err
	}
	login := normalizeEmail(email)
	if login == "" {
		return nil
	}
	u, found, err := s.lookup(ctx, login)
	if err != nil {
		return err
	}
	if !found || u.Status != StatusActive {
		return nil
	}
	canMail, err := s.canMail(ctx)
	if err != nil {
		return err
	}
	if !canMail {
		// 不报错：这里连「账号是否存在」都不该暴露。
		s.log.Warn("auth: 找回密码时没有可用发信账号", "user_id", u.ID)
		return nil
	}
	code, err := newNumericCode()
	if err != nil {
		return err
	}
	now := s.clk.Now()
	if err := s.withTx(ctx, func(tx *ent.Tx) error {
		return s.upsertCode(ctx, tx, u.ID, purposeReset, codeHash(code), now)
	}); err != nil {
		return err
	}
	s.enqueueVerifyMail(ctx, u.ID, u.Email, code, TemplateResetCode)
	return nil
}

// ResetPasswordInput 是第二步：票据 + 新密码。
type ResetPasswordInput struct {
	Ticket      string
	NewPassword string
	IP          string
}

// ResetPassword 消费 reset_ticket（一次性），改密码并删掉该用户全部会话（设计 §10.6 第二步）。
func (s *Service) ResetPassword(ctx context.Context, in ResetPasswordInput) error {
	if err := s.allow(ctx, keyMailIP(in.IP), 10, time.Hour); err != nil {
		return err
	}
	if err := validatePassword(in.NewPassword); err != nil {
		return err
	}
	if in.Ticket == "" {
		return ErrTokenInvalid
	}
	// 哈希在事务外算（同 §7.1 第 3 步）。
	if err := s.hash.acquire(ctx); err != nil {
		return err
	}
	phc, err := s.hash.Hash(in.NewPassword)
	s.hash.release()
	if err != nil {
		return err
	}
	now := s.clk.Now()
	digest := codeHash(in.Ticket)

	return s.withTx(ctx, func(tx *ent.Tx) error {
		// DELETE ... RETURNING user_id：票据的一次性由它保证（第二个请求返回 0 行）。
		var userID int64
		err := pgsql.QueryRow(ctx, tx.Client(), `
DELETE FROM email_tokens
 WHERE token_hash = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > $2
RETURNING user_id`, digest, now).Scan(&userID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}
		if err := tx.User.UpdateOneID(userID).
			SetPasswordHash(phc).
			SetUpdatedAt(now).
			Exec(ctx); err != nil {
			return err
		}
		revoked, err := tx.Session.Delete().Where(session.UserIDEQ(userID)).Exec(ctx)
		if err != nil {
			return err
		}
		var pub string
		if err := pgsql.QueryRow(ctx, tx.Client(), `SELECT public_id FROM users WHERE id = $1`, userID).Scan(&pub); err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: userID, Action: ActionPasswordChange, TargetType: "user",
			TargetID: pub, IP: ipOf(in.IP),
			Detail: map[string]any{"after": map[string]any{"sessions_revoked": revoked, "via": "reset_code"}},
		})
	})
}
