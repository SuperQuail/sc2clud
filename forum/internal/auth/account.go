package auth

import (
	"context"
	"errors"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/emailtoken"
	"forum/internal/ent/role"
	"forum/internal/ent/session"
	"forum/internal/ent/user"
	"forum/internal/ent/userpermission"
	"forum/internal/platform/apperr"
	"forum/internal/platform/captcha"
	"forum/internal/platform/idgen"
)

// ── 信任边界上的校验（唯一的校验处，内部调用之间不再加防御） ──────────────────

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_-]{2,23}$`)

const (
	nicknameMaxLen = 20 // 与 users.nickname varchar(20) 一致，按 rune 计
	bioMaxLen      = 200
	passwordMinLen = 8
	passwordMaxLen = 128
)

// normalizeUsername 只去空白：大小写保持用户输入的原样，唯一性靠 uq_users_username_lower。
func normalizeUsername(v string) string { return strings.TrimSpace(v) }

// normalizeEmail 去空白 + 小写（设计 §7.1：落库前统一）。
func normalizeEmail(v string) string { return strings.ToLower(strings.TrimSpace(v)) }

func validateUsername(v string) error {
	if !usernameRe.MatchString(v) {
		return invalid("username", "3-24 位，只能用字母、数字、下划线、连字符，且不能以连字符开头")
	}
	return nil
}

func validateEmail(v string) error {
	if v == "" || len(v) > 254 {
		return invalid("email", "邮箱格式不正确")
	}
	addr, err := mail.ParseAddress(v)
	if err != nil || addr.Address != v {
		return invalid("email", "邮箱格式不正确")
	}
	at := strings.LastIndex(v, "@")
	if at < 0 || !strings.Contains(v[at+1:], ".") {
		return invalid("email", "邮箱格式不正确")
	}
	return nil
}

func validatePassword(v string) error {
	if len(v) < passwordMinLen || len(v) > passwordMaxLen {
		return invalid("password", "密码长度必须是 8-128 个字节")
	}
	if strings.TrimSpace(v) == "" {
		return invalid("password", "密码不能全是空白")
	}
	return nil
}

// validateNickname 空串表示「没填」，由调用方回落到 username。
func validateNickname(v string) error {
	if v == "" {
		return nil
	}
	if len([]rune(v)) > nicknameMaxLen {
		return invalid("nickname", "昵称最多 20 个字")
	}
	if strings.TrimSpace(v) == "" {
		return invalid("nickname", "昵称不能全是空白")
	}
	return nil
}

// ── 限流 key（设计 §9.5 的表，一处定义） ────────────────────────────────

func keyRegisterIP(ip string) string   { return "auth:register:ip:" + ip }
func keyLoginIP(ip string) string      { return "auth:login:ip:" + ip }
func keyLoginUser(login string) string { return "auth:login:user:" + strings.ToLower(login) }
func keyMailIP(ip string) string       { return "auth:mail:ip:" + ip }
func keyMailUser(id int64) string      { return "auth:mail:user:" + strconv.FormatInt(id, 10) }
func keyMailVerifyUser(id int64) string {
	return "auth:mail:verify:user:" + strconv.FormatInt(id, 10)
}

// errLimiterUnavailable 是限流后端不可用：**必须拒绝放行**（platform/kv 的约定：
// 缓存类调用方把不可用当未命中，限流类调用方必须拒绝，否则 Redis 一挂就等于没有限流）。
var errLimiterUnavailable = errors.New("auth: 限流后端不可用")

// allow 是限流判定的唯一出口：被拒时返回带 Retry-After 的 429。
func (s *Service) allow(ctx context.Context, key string, limit int, window time.Duration) error {
	if s.limiter == nil {
		return nil
	}
	ok, retry, err := s.limiter.Allow(ctx, key, limit, window)
	if err != nil {
		s.log.Error("auth: 限流后端不可用", "key", key, "err", err.Error())
		return errLimiterUnavailable
	}
	if ok {
		return nil
	}
	secs := int(retry.Seconds())
	if secs < 1 {
		secs = 1
	}
	return ErrTooManyRequests.WithMsg("操作太频繁，请 " + strconv.Itoa(secs) + " 秒后再试")
}

// checkCaptcha 是注册与登录共用的人机验证闸门，三种模式的语义都在这里生效：
//
//	off        不要求（注册有邮箱验证兜底、登录有限流兜底）；
//	on_failure 同一 IP 10 分钟内失败 ≥5 次之后才要求；
//	always     每次都要求。
//
// 「要不要」由 captcha 模块判（阈值与窗口写死在它那边，不进配置），本域只消费结论。
// 没装配实现（nil）时按 off：captcha.mode=off 本来就不需要它，app 层在别的模式下
// 一定会注入（装不上就不让进程起来）。
func (s *Service) checkCaptcha(ctx context.Context, ip, id, answer string) error {
	if s.captcha == nil || !s.captcha.Required(ctx, ip, s.cfg.Captcha.Mode) {
		return nil
	}
	if id == "" || answer == "" {
		return ErrCaptchaRequired
	}
	return s.mapCaptchaErr(s.captcha.Verify(ctx, id, answer))
}

// mapCaptchaErr 把出题器的错误翻成本域的码。**答错与「这道题不存在/已过期」对外同一个码**：
// 区分只会泄漏「这个 id 存在过」（d5-content §7.2）。
func (s *Service) mapCaptchaErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, captcha.ErrWrong):
		return ErrCaptchaWrong
	case errors.Is(err, captcha.ErrUnavailable):
		s.log.Error("auth: 验证码服务不可用", "err", err.Error())
		return ErrCaptchaUnavailable
	default:
		s.log.Error("auth: 校验验证码失败", "err", err.Error())
		return apperr.ErrInternal
	}
}

// countLoginFailure 记一次失败（on_failure 模式据此决定何时开始要求验证码）。
func (s *Service) countLoginFailure(ctx context.Context, ip string) {
	if s.captcha != nil {
		s.captcha.CountFailure(ctx, ip)
	}
}

// resetLoginFailures 在成功时清零：「连续失败」的定义要求成功清零（d5-content §7.2）。
func (s *Service) resetLoginFailures(ctx context.Context, ip string) {
	if s.captcha != nil {
		s.captcha.ResetFailures(ctx, ip)
	}
}

// ── 注册 ────────────────────────────────────────────────────────────

func (s *Service) Register(ctx context.Context, in RegisterInput) (*RegisterResult, error) {
	if err := s.allow(ctx, keyRegisterIP(in.IP), 3, time.Hour); err != nil {
		return nil, err
	}
	// 从这里开始的每一种「没能注册」都算一次失败（on_failure 模式据此开始要求验证码）。
	// 限流被拒不算：那是「你太快了」，不是「你填错了」（设计 §7.1 第 1 步排在校验之前）。
	var success bool
	defer func() {
		if success {
			s.resetLoginFailures(ctx, in.IP)
			return
		}
		s.countLoginFailure(ctx, in.IP)
	}()
	username := normalizeUsername(in.Username)
	email := normalizeEmail(in.Email)
	if err := validateUsername(username); err != nil {
		return nil, err
	}
	if err := validateEmail(email); err != nil {
		return nil, err
	}
	if err := validatePassword(in.Password); err != nil {
		return nil, err
	}
	// 昵称留空 = 没设显示名，**空串原样落库**，不回填成 username：
	// 显示名与登录名是两个语义（显示名可重名、可改；登录名是 @ 句柄、不可改），
	// 回填会把「没设」写成一个看起来像用户主动设过的值，之后再改用户名（不允许）或
	// 迁移数据都会以为它是真昵称。留空的显示由**读路径**回落（见 auth.Me / user.GetProfile）。
	nickname := strings.TrimSpace(in.Nickname)
	if err := validateNickname(nickname); err != nil {
		return nil, err
	}
	if err := s.checkCaptcha(ctx, in.IP, in.CaptchaID, in.CaptchaAnswer); err != nil {
		return nil, err
	}

	// 哈希在**事务外**算：32MB + 几十毫秒，绝不放事务里（设计 §7.1 第 3 步）。
	if err := s.hash.acquire(ctx); err != nil {
		return nil, err
	}
	phc, err := s.hash.Hash(in.Password)
	s.hash.release()
	if err != nil {
		return nil, err
	}

	// 验证码也在事务外生成：如果它失败而账号已经建好，那个人就永远收不到码。
	code, err := newNumericCode()
	if err != nil {
		return nil, err
	}

	// 拍板 §12.2：模式由**一个开关**决定，不再按「发信成功与否」推断。
	//   auto_activate=true  且没有可用发信账号 → 503 auth.mail_unavailable（**不静默降级成人工**，
	//                        否则管理员会以为「注册走人工」是产品设计，而真实原因是配置坏了）；
	//   auto_activate=false → 不发任何邮件，等管理员在后台激活。
	auto := s.cfg.Auth.AutoActivateOn()
	if auto {
		canMail, err := s.canMail(ctx)
		if err != nil {
			return nil, err
		}
		if !canMail {
			return nil, ErrMailUnavailable
		}
	}

	// 显式预检占用：唯一索引是最终保证，但按约束名区分「哪个撞了」要靠 pgconn 的 ConstraintName，
	// 而它依赖 ent 生成的约束名，不稳。这里先查一次（两条都走 lower(col) 表达式索引），
	// 撞车时直接给出能挂到输入框上的码；真正的并发重放仍由唯一索引兜底（走 mapRegisterErr）。
	uname, ufound, err := s.lookup(ctx, username)
	if err != nil {
		return nil, err
	}
	if ufound && uemailClash(uname, username) {
		return nil, ErrHandleTaken
	}
	uemail, efound, err := s.lookup(ctx, email)
	if err != nil {
		return nil, err
	}
	if efound && uemailClash(uemail, email) {
		return nil, ErrEmailTaken
	}

	pub, err := idgen.NewPublicID()
	if err != nil {
		return nil, err
	}
	now := s.clk.Now()

	var userID int64
	err = s.withTx(ctx, func(tx *ent.Tx) error {
		roleID, err := tx.Role.Query().Where(role.KeyEQ("user")).OnlyID(ctx)
		if err != nil {
			return err
		}
		u, err := tx.User.Create().
			SetPublicID(pub).
			SetUsername(username).
			SetEmail(email).
			SetPasswordHash(phc).
			SetNickname(nickname).
			SetRoleID(roleID).
			SetStatus(StatusActive).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			return err
		}
		userID = u.ID
		if auto {
			if err := s.upsertCode(ctx, tx, userID, purposeVerify, codeHash(code), now); err != nil {
				return err
			}
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			Action: ActionUserRegister, TargetType: "user",
			TargetID: pub.String(), IP: ipOf(in.IP), Detail: map[string]any{},
		})
	})
	if err != nil {
		return nil, s.mapRegisterErr(err)
	}
	// 注册成功：defer 里据此清零而不是记失败（「连续失败」的定义要求成功清零）。
	success = true

	// 提交后入队（方案 §14.6：事务里禁止发信）。入队失败不回滚注册：
	// 用户点「重新发送」就能补上，而回滚会让「账号已建好但报错」变成更坏的结果（设计 §16.3）。
	if auto {
		s.enqueueVerifyMail(ctx, userID, email, code, TemplateVerifyEmail)
	}
	return &RegisterResult{
		ID:            pub.String(),
		Handle:        username,
		EmailVerified: false,
		AutoActivate:  auto,
	}, nil
}

// canMail 问 mail 模块「现在能不能发信」。没配实现时按不能（manual 兜底）。
func (s *Service) canMail(ctx context.Context) (bool, error) {
	if s.mail == nil {
		return false, nil
	}
	return s.mail.HasUsable(ctx)
}

// enqueueVerifyMail 是发码的唯一下游动作：Mailer 建 mail_logs 行并返回 id，本域入队。
// 两处调用（注册、重发）共用它，避免两份「建行 + 入队」的写法漂移。
func (s *Service) enqueueVerifyMail(ctx context.Context, userID int64, to, code, tpl string) {
	if s.mailer == nil || s.queue == nil {
		s.log.Error("auth: 没有配发信实现，验证码没发出去", "user_id", userID, "template", tpl)
		return
	}
	sendID, err := s.mailer.SendVerifyCode(ctx, userID, to, code, tpl)
	if err != nil {
		s.log.Error("auth: 建发信记录失败", "user_id", userID, "template", tpl, "err", err.Error())
		return
	}
	if err := enqueueMail(ctx, s.queue, sendID); err != nil {
		// 码还在库里、用户点重发就能补——这正是「事务里不发信」买来的性质（设计 §16.3）。
		s.log.Error("auth: 入队 mail:send 失败", "send_id", sendID, "err", err.Error())
	}
}

// upsertCode 写一条活跃验证码（注册时与重发共用）。重发的语义是「作废旧的、发新的」。
func (s *Service) upsertCode(ctx context.Context, tx *ent.Tx, userID int64, purpose string, hash []byte, now time.Time) error {
	// 先把该 purpose 的旧行物理删掉：部分唯一索引 uq_email_tokens_live 的谓词只有
	// used_at IS NULL（拍板 §5.9 第 1 条：谓词里不能有 now()），所以「未消费」的行只能有一条，
	// 重发必须让旧行让位（拍板 §11.2 / §11.8 第 4 条：旧码立刻失效）。
	if _, err := tx.EmailToken.Delete().
		Where(emailtoken.UserIDEQ(userID), emailtoken.PurposeEQ(purpose)).
		Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.EmailToken.Create().
		SetUserID(userID).
		SetTokenHash(hash).
		SetPurpose(purpose).
		SetExpiresAt(now.Add(codeTTL)).
		SetCreatedAt(now).
		Save(ctx); err != nil {
		return err
	}
	s.codes.forget(userID, purpose)
	return nil
}

// mapRegisterErr 把唯一索引冲突翻成能挂到输入框上的码。
// 约束名在迁移里写死（uq_users_username_lower / uq_users_email_lower），按它区分是哪一个撞了。
func (s *Service) mapRegisterErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		switch {
		case strings.Contains(pg.ConstraintName, "username"):
			return ErrHandleTaken
		case strings.Contains(pg.ConstraintName, "email"):
			return ErrEmailTaken
		}
		return apperr.ErrConflict
	}
	return err
}

// ── 登录 ────────────────────────────────────────────────────────────

func (s *Service) Login(ctx context.Context, in LoginInput) (*LoginResult, error) {
	login := strings.TrimSpace(in.Login)
	if login == "" || in.Password == "" {
		s.countLoginFailure(ctx, in.IP)
		return nil, ErrBadCredentials
	}
	if err := s.allow(ctx, keyLoginIP(in.IP), 10, time.Minute); err != nil {
		return nil, err
	}
	if err := s.allow(ctx, keyLoginUser(login), 5, time.Minute); err != nil {
		return nil, err
	}
	if err := s.checkCaptcha(ctx, in.IP, in.CaptchaID, in.CaptchaAnswer); err != nil {
		return nil, err
	}

	row, found, err := s.lookup(ctx, login)
	if err != nil {
		return nil, err
	}

	// 恒时校验：账号不存在也走一次同样参数的 argon2（设计 §7.2 第 3 步）。
	// 两种失败返回**同一个码**，不区分「不存在」与「密码错」。
	if err := s.hash.acquire(ctx); err != nil {
		return nil, err
	}
	var verified bool
	if found {
		verified = s.hash.Verify(row.PasswordHash, in.Password)
	} else {
		s.hash.dummy(in.Password)
	}
	rehash := verified && found && s.hash.needsRehash(row.PasswordHash)
	var phc string
	if rehash {
		phc, err = s.hash.Hash(in.Password)
	}
	s.hash.release()
	if err != nil {
		return nil, err
	}
	if !found || !verified {
		s.countLoginFailure(ctx, in.IP)
		return nil, ErrBadCredentials
	}
	// 封号不暴露（设计 §7.2 第 4 步）：对外与「密码错」完全一样。
	// **邮箱未验证 / 未激活都允许登录**（拍板 §9.12）：不允许的话他连重发验证码都点不到。
	if row.Status != StatusActive {
		s.countLoginFailure(ctx, in.IP)
		return nil, ErrBadCredentials
	}

	now := s.clk.Now()
	var token string
	var expires time.Time
	err = s.withTx(ctx, func(tx *ent.Tx) error {
		token, expires, err = s.newSession(ctx, tx, row.ID, in.IP, in.UserAgent)
		if err != nil {
			return err
		}
		if rehash {
			// 与建会话同一个事务：失败就整体回滚，**不返回「登录成功但哈希没升级」**（设计 §7.3）。
			if err := tx.User.UpdateOneID(row.ID).
				SetPasswordHash(phc).
				SetUpdatedAt(now).
				Exec(ctx); err != nil {
				return err
			}
		}
		if err := tx.User.UpdateOneID(row.ID).SetLastLoginAt(now).SetUpdatedAt(now).Exec(ctx); err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: row.ID, Action: ActionUserLogin, TargetType: "user",
			TargetID: row.PublicID, IP: ipOf(in.IP), Detail: map[string]any{},
		})
	})
	if err != nil {
		return nil, err
	}
	s.resetLoginFailures(ctx, in.IP)
	return &LoginResult{Token: token, ExpiresAt: expires}, nil
}

// lookup 走 user 模块的实现（它拥有 users 表的读路径）。
func (s *Service) lookup(ctx context.Context, login string) (*UserAuthRow, bool, error) {
	if s.users == nil {
		return nil, false, errors.New("auth: 没有配 UserLookup")
	}
	row, err := s.users.GetAuthRow(ctx, login)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return row, true, nil
}

// ErrUserNotFound 是 UserLookup 的「查不到」约定（user 模块返回它）。
var ErrUserNotFound = errors.New("auth: 用户不存在")

// ── 我的账号 ────────────────────────────────────────────────────────

func (s *Service) Me(ctx context.Context, actor *authz.Actor) (*MeResult, error) {
	if actor == nil {
		return nil, nil
	}
	u, err := s.db.User.Query().Where(user.IDEQ(actor.UserID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	extra, err := s.extraOf(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	return &MeResult{
		ID:            u.PublicID.String(),
		Handle:        u.Username,
		Nickname:      displayName(u.Nickname, u.Username),
		Email:         u.Email,
		Avatar:        deref(u.AvatarHash),
		AvatarSmall:   deref(u.AvatarSmallHash),
		Bio:           u.Bio,
		Status:        u.Status,
		EmailVerified: u.EmailVerifiedAt != nil,
		Activated:     u.ActivatedAt != nil,
		AutoActivate:  s.cfg.Auth.AutoActivateOn(),
		Trusted:       u.Trusted,
		Level:         u.Level,
		Exp:           u.Exp,
		ExpMax:        ExpMax(u.Level),
		Role: RoleItem{
			ID: actor.RoleID, Key: actor.RoleKey, Name: actor.RoleName, BadgeColor: actor.RoleBadge,
		},
		Perms:     actor.Perms.Keys(),
		Extra:     extra,
		BoardIDs:  actor.BoardIDs,
		CreatedAt: u.CreatedAt,
	}, nil
}

// extraOf 取点对点追加的权限（未过期的）。它只是 /me 的展示字段，不参与判定——
// 判定用的权限集合已经在 Perms 里算好了。
func (s *Service) extraOf(ctx context.Context, userID int64) ([]ExtraPermItem, error) {
	rows, err := s.db.UserPermission.Query().
		Where(userpermission.UserIDEQ(userID)).
		WithPermission().
		All(ctx)
	if err != nil {
		return nil, err
	}
	now := s.clk.Now()
	out := make([]ExtraPermItem, 0, len(rows))
	for _, r := range rows {
		if r.ExpiresAt != nil && !r.ExpiresAt.After(now) {
			continue
		}
		p, err := r.Edges.PermissionOrErr()
		if err != nil {
			return nil, err
		}
		out = append(out, ExtraPermItem{Key: p.Key, ExpiresAt: r.ExpiresAt})
	}
	return out, nil
}

// UpdateProfile 只写**请求里出现的字段**。头像归 media 模块写，这里一列都不碰（拍板 U20）。
type UpdateProfileInput struct {
	Nickname *string
	Bio      *string
}

func (s *Service) UpdateProfile(ctx context.Context, actor *authz.Actor, in UpdateProfileInput) error {
	if actor == nil {
		return unauthorized()
	}
	upd := s.db.User.UpdateOneID(actor.UserID).SetUpdatedAt(s.clk.Now())
	if in.Nickname != nil {
		n := strings.TrimSpace(*in.Nickname)
		if err := validateNickname(n); err != nil {
			return err
		}
		if n == "" {
			return invalid("nickname", "昵称不能为空")
		}
		upd.SetNickname(n)
	}
	if in.Bio != nil {
		b := strings.TrimSpace(*in.Bio)
		if len([]rune(b)) > bioMaxLen {
			return invalid("bio", "简介最多 200 个字")
		}
		upd.SetBio(b)
	}
	return upd.Exec(ctx)
}

// ChangePassword 成功后删掉该用户的**全部**会话（含当前会话）：带旧 Cookie 的请求立刻 401。
type ChangePasswordInput struct {
	OldPassword string
	NewPassword string
	IP          string
}

func (s *Service) ChangePassword(ctx context.Context, actor *authz.Actor, in ChangePasswordInput) error {
	if actor == nil {
		return unauthorized()
	}
	if err := s.allow(ctx, keyLoginUser(actor.PublicID), 5, time.Minute); err != nil {
		return err
	}
	if err := validatePassword(in.NewPassword); err != nil {
		return err
	}
	u, err := s.db.User.Query().Where(user.IDEQ(actor.UserID)).Only(ctx)
	if err != nil {
		return err
	}

	// 事务外：取信号量、校验旧密码、算新哈希。
	if err := s.hash.acquire(ctx); err != nil {
		return err
	}
	ok := s.hash.Verify(u.PasswordHash, in.OldPassword)
	same := s.hash.Verify(u.PasswordHash, in.NewPassword)
	var phc string
	if ok {
		phc, err = s.hash.Hash(in.NewPassword)
	}
	s.hash.release()
	if err != nil {
		return err
	}
	if !ok {
		return ErrBadCredentials
	}
	if same {
		return invalid("new_password", "新密码不能与旧密码相同")
	}

	now := s.clk.Now()
	return s.withTx(ctx, func(tx *ent.Tx) error {
		if err := tx.User.UpdateOneID(actor.UserID).
			SetPasswordHash(phc).
			SetUpdatedAt(now).
			Exec(ctx); err != nil {
			return err
		}
		revoked, err := tx.Session.Delete().
			Where(session.UserIDEQ(actor.UserID)).
			Exec(ctx)
		if err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionPasswordChange, TargetType: "user",
			TargetID: actor.PublicID, IP: ipOf(in.IP),
			Detail: map[string]any{"after": map[string]any{"sessions_revoked": revoked}},
		})
	})
}

// ── 封号 / 强制下线 ─────────────────────────────────────────────────

// BanInput 的 Action 只有 ban / unban 两个值。
type BanInput struct {
	UserPublicID string
	Action       string
	Reason       string
	IP           string
}

type BanResult struct {
	Status          string `json:"status"`
	SessionsRevoked int    `json:"sessions_revoked"`
}

func (s *Service) BanUser(ctx context.Context, actor *authz.Actor, in BanInput) (*BanResult, error) {
	if err := requirePerm(actor, authz.PermUserBan); err != nil {
		return nil, err
	}
	target, err := s.userByPublicID(ctx, in.UserPublicID)
	if err != nil {
		return nil, err
	}
	var want string
	switch in.Action {
	case "ban":
		want = StatusBanned
	case "unban":
		want = StatusActive
	default:
		return nil, invalid("action", "只能是 ban 或 unban")
	}
	if target.Status == want {
		// 重复封号 = 置目标状态，不是错误（设计 §9.5 的幂等列）。
		return &BanResult{Status: want}, nil
	}
	now := s.clk.Now()
	var revoked int
	err = s.withTx(ctx, func(tx *ent.Tx) error {
		if want == StatusBanned {
			// 设计 §8.9：改角色与封号**两条路都要挡**，少挡一条守卫就是摆设。
			if err := s.guardLastSuper(ctx, tx, target.ID); err != nil {
				return err
			}
		}
		if err := tx.User.UpdateOneID(target.ID).SetStatus(want).SetUpdatedAt(now).Exec(ctx); err != nil {
			return err
		}
		if want == StatusActive {
			return s.writeAudit(ctx, tx, AuditEntry{
				ActorID: actor.UserID, Action: ActionUserBan, TargetType: "user",
				TargetID: target.PublicID.String(), IP: ipOf(in.IP),
				Detail: map[string]any{"before": map[string]any{"status": target.Status},
					"after": map[string]any{"status": want, "reason": in.Reason}},
			})
		}
		// 封号**不删会话行**（设计 §6.6）：删行会让解封后用户「莫名其妙要重新登录」，而且不可逆。
		// 失效靠解析路径判 status（下一个请求就是 401），所以这里只数一下有多少条会立刻失效。
		n, err := tx.Session.Query().Where(session.UserIDEQ(target.ID)).Count(ctx)
		if err != nil {
			return err
		}
		revoked = n
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionUserBan, TargetType: "user",
			TargetID: target.PublicID.String(), IP: ipOf(in.IP),
			Detail: map[string]any{"before": map[string]any{"status": target.Status},
				"after": map[string]any{"status": want, "reason": in.Reason}},
		})
	})
	if err != nil {
		return nil, err
	}
	if want == StatusBanned {
		// 会话行已删；缓存契约里那一条也走一遍（本轮无缓存，保留调用点）。
		if err := s.InvalidateUser(ctx, target.ID); err != nil {
			return nil, err
		}
	}
	return &BanResult{Status: want, SessionsRevoked: revoked}, nil
}

// ActivateUser 是管理员手工激活（拍板 §12.2 路径 B）：auto_activate=false 时它是**唯一**的激活入口。
//
// 它只写 activated_at：**email_verified_at 保持 NULL**——手工激活不等于邮箱验证，两根轴不要合并
// （拍板 §12.2 验收第 4 条）。幂等：已激活再点一次返回成功。
func (s *Service) ActivateUser(ctx context.Context, actor *authz.Actor, userPublicID, ip string) error {
	if err := requirePerm(actor, authz.PermUserBan); err != nil {
		return err
	}
	target, err := s.userByPublicID(ctx, userPublicID)
	if err != nil {
		return err
	}
	now := s.clk.Now()
	return s.withTx(ctx, func(tx *ent.Tx) error {
		if target.ActivatedAt == nil {
			if err := tx.User.UpdateOneID(target.ID).SetActivatedAt(now).SetUpdatedAt(now).Exec(ctx); err != nil {
				return err
			}
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionUserActivate, TargetType: "user",
			TargetID: target.PublicID.String(), IP: ipOf(ip),
			Detail: map[string]any{"after": map[string]any{"activated_at": now}},
		})
	})
}

// RevokeResult 是强制下线的结果：被踢条数（第二次是 0）。
type RevokeResult struct {
	Revoked int `json:"revoked"`
}

func (s *Service) RevokeUserSessions(ctx context.Context, actor *authz.Actor, userPublicID, ip string) (*RevokeResult, error) {
	if err := requirePerm(actor, authz.PermUserBan); err != nil {
		return nil, err
	}
	target, err := s.userByPublicID(ctx, userPublicID)
	if err != nil {
		return nil, err
	}
	var n int
	err = s.withTx(ctx, func(tx *ent.Tx) error {
		var err error
		n, err = tx.Session.Delete().Where(session.UserIDEQ(target.ID)).Exec(ctx)
		if err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionSessionsRevoke, TargetType: "user",
			TargetID: target.PublicID.String(), IP: ipOf(ip),
			Detail: map[string]any{"after": map[string]any{"revoked": n}},
		})
	})
	if err != nil {
		return nil, err
	}
	return &RevokeResult{Revoked: n}, nil
}

// guardLastSuper 是设计 §8.9 的守卫：目标当前是超管、且 write 会让 active 超管数减小时执行。
// 与写操作同事务 + FOR UPDATE，保证判定与写入之间没有窗口。
func (s *Service) guardLastSuper(ctx context.Context, tx *ent.Tx, targetID int64) error {
	var wasSuper bool
	var remaining int
	err := pgsql.QueryRow(ctx, tx.Client(), `
WITH target AS (
    SELECT u.id, r.is_super AS was_super
      FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1
     FOR UPDATE OF u
),
remaining AS (
    SELECT count(*) AS n
      FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.is_super AND u.id <> $1 AND u.status = 'active'
)
SELECT t.was_super, (SELECT n FROM remaining) FROM target t`, targetID).Scan(&wasSuper, &remaining)
	if err != nil {
		return err
	}
	if wasSuper && remaining == 0 {
		return ErrAdminLastSuper
	}
	return nil
}

// uemailClash 判断「查回来的这一行是不是被这个值占用了」。
// FindUserByLogin 的谓词是 username OR email，所以命中的可能是另一种字段——逐字比一次。
func uemailClash(row *UserAuthRow, value string) bool {
	return strings.EqualFold(row.Username, value) || strings.EqualFold(row.Email, value)
}

// userByPublicID 按 public_id 找用户（管理端一律用它，不接受自增 id）。
func (s *Service) userByPublicID(ctx context.Context, publicID string) (*ent.User, error) {
	uid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, ErrAdminUserNotFound
	}
	u, err := s.db.User.Query().Where(user.PublicIDEQ(uid)).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, ErrAdminUserNotFound
		}
		return nil, err
	}
	return u, nil
}

// CreateAdmin 是 CLI：全站必须有至少一个 superadmin，否则没人能进后台（设计 §8.7）。
// 它自己**不受「最后一个超管」守卫限制**（只增不减），也不做隐式升级。
type CreateAdminInput struct {
	Handle   string
	Email    string
	Nickname string
	Password string
}

func (s *Service) CreateAdmin(ctx context.Context, in CreateAdminInput) error {
	username := normalizeUsername(in.Handle)
	email := normalizeEmail(in.Email)
	if err := validateUsername(username); err != nil {
		return err
	}
	if err := validateEmail(email); err != nil {
		return err
	}
	if err := validatePassword(in.Password); err != nil {
		return err
	}
	nickname := strings.TrimSpace(in.Nickname)
	if err := validateNickname(nickname); err != nil {
		return err
	}
	if _, found, err := s.lookup(ctx, username); err != nil {
		return err
	} else if found {
		return ErrHandleTaken
	}
	if _, found, err := s.lookup(ctx, email); err != nil {
		return err
	} else if found {
		return ErrEmailTaken
	}

	if err := s.hash.acquire(ctx); err != nil {
		return err
	}
	phc, err := s.hash.Hash(in.Password)
	s.hash.release()
	if err != nil {
		return err
	}
	pub, err := idgen.NewPublicID()
	if err != nil {
		return err
	}
	now := s.clk.Now()
	return s.withTx(ctx, func(tx *ent.Tx) error {
		superID, err := tx.Role.Query().Where(role.IsSuperEQ(true)).OnlyID(ctx)
		if err != nil {
			return err
		}
		u, err := tx.User.Create().
			SetPublicID(pub).
			SetUsername(username).
			SetEmail(email).
			SetPasswordHash(phc).
			SetNickname(nickname).
			SetRoleID(superID).
			SetStatus(StatusActive).
			SetTrusted(true).
			SetEmailVerifiedAt(now).
			SetActivatedAt(now).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			Action: ActionUserCreateAdmin, TargetType: "user", TargetID: u.PublicID.String(),
			Detail: map[string]any{},
		})
	})
}
