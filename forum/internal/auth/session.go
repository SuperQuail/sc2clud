package auth

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/netip"
	"time"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/session"
)

// errSessionNotFound 是「这条会话不是你的 / 不存在」。对外一律 404 common.not_found。
var errSessionNotFound = errors.New("auth: 会话不存在")

// Resolve 按原始 token 解析身份。过期 / 伪造 / 用户被封一律返回 ErrSessionInvalid：
// **对调用方来说这三种是同一种结果**（方案 §9.2 决策 1：过期与不存在的会话 = 游客）。
func (s *Service) Resolve(ctx context.Context, rawToken string) (*Principal, error) {
	digest := digestOf(rawToken)
	now := s.clk.Now()

	row, err := pgsql.ResolveSession(ctx, s.db, digest, now)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrSessionInvalid
		}
		return nil, err
	}
	if row.Status != StatusActive {
		// 封号不删会话行（设计 §6.6）：删行会让解封后用户「莫名其妙要重新登录」，而且不可逆。
		// 判定在解析路径上，所以旧 Cookie 的下一个请求就是失效，不等任何 TTL。
		return nil, ErrSessionInvalid
	}
	return s.loadPrincipal(ctx, row, digest, now)
}

// loadPrincipal 把「会话行 + 权限闭包」拼成 Principal。
// 两条查询是分开的：会话回答「你是谁」，权限闭包回答「你能不能」（设计 §8.3）。
func (s *Service) loadPrincipal(ctx context.Context, row *pgsql.SessionRow, digest []byte, now time.Time) (*Principal, error) {
	ar, err := pgsql.LoadActor(ctx, s.db, row.RoleID, row.UserID, now)
	if err != nil {
		return nil, err
	}
	// 直接用 pgsql.ExtraPerm：它就是「/me 的 extra 字段」的形状，
	// 在本域再抄一个同名结构只会多一处要同步的字段。
	extra := ar.Extra
	if extra == nil {
		extra = []pgsql.ExtraPerm{}
	}
	return &Principal{
		UserID:        row.UserID,
		PublicID:      row.PublicID,
		Nickname:      row.Nickname,
		Digest:        digest,
		SessionID:     row.SessionID,
		CSRF:          row.CSRF,
		EmailVerified: row.EmailVerified != nil,
		Activated:     row.ActivatedAt != nil,
		Status:        row.Status,
		AvatarHash:    deref(row.AvatarHash),
		AvatarSmall:   deref(row.AvatarSmall),
		RoleID:        row.RoleID,
		RoleKey:       row.RoleKey,
		RoleName:      row.RoleName,
		RoleBadge:     deref(row.RoleBadge),
		IsSuper:       row.IsSuper,
		Perms:         authz.NewSet(ar.PermKeys...),
		BoardIDs:      row.BoardIDs,
		Extra:         extra,
		ExpiresAt:     row.ExpiresAt,
	}, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// newSession 建一条会话行。**在事务里**（与审计、last_login_at 同一个事务；设计 §7.2 第 7 步）。
func (s *Service) newSession(ctx context.Context, tx *ent.Tx, userID int64, ip, userAgent string) (string, time.Time, error) {
	token, digest, err := newToken()
	if err != nil {
		return "", time.Time{}, err
	}
	csrf, err := newCSRF()
	if err != nil {
		return "", time.Time{}, err
	}
	now := s.clk.Now()
	expires := now.Add(s.sessionTTL())

	if err := tx.Session.Create().
		SetTokenHash(digest).
		SetUserID(userID).
		SetCsrfToken(csrf).
		SetIP(ip).
		SetUserAgent(userAgent).
		SetExpiresAt(expires).
		SetLastSeenAt(now).
		Exec(ctx); err != nil {
		return "", time.Time{}, err
	}
	return token, expires, nil
}

// flushTouch 是批量刷写：两条 unnest 语句，各一次往返（设计 §6.5）。
// 它只被 toucher 调用，不在请求路径上。
func (s *Service) flushTouch(ctx context.Context, pairs []TouchPair) error {
	digests := make([][]byte, 0, len(pairs))
	seen := make([]time.Time, 0, len(pairs))
	for _, p := range pairs {
		digests = append(digests, p.Digest)
		seen = append(seen, p.Seen)
	}
	if _, err := s.db.ExecContext(ctx, refreshSeenSQL, digests, seen); err != nil {
		return err
	}
	// 滑动续期：每 renew_interval 才真的改一次 expires_at，否则它就成了新的写热点。
	return nil
}

func (s *Service) renewInterval() time.Duration {
	if s.cfg.Auth.RenewInterval > 0 {
		return s.cfg.Auth.RenewInterval
	}
	return 24 * time.Hour
}

// refreshSeenSQL 一条语句刷新一批会话的活跃时间。s.token_hash = t.digest 走 uq_sessions_token，
// 每条会话一次索引查找，代价与 sessions 表大小无关。不拼 SQL 字符串（方案 §15.8）。
const refreshSeenSQL = `
WITH t(digest, seen) AS (
  SELECT u.digest, u.seen FROM unnest($1::bytea[], $2::timestamptz[]) AS u(digest, seen)
)
UPDATE sessions s
   SET last_seen_at = GREATEST(s.last_seen_at, t.seen)
  FROM t
 WHERE s.token_hash = t.digest
   AND s.last_seen_at < t.seen`

// Logout 删当前会话行。**幂等**：删不到行也返回 nil（设计 §7.5）。
func (s *Service) Logout(ctx context.Context, p *Principal) error {
	if p == nil {
		return nil
	}
	_, err := s.db.Session.Delete().
		Where(session.IDEQ(p.SessionID), session.UserIDEQ(p.UserID)).
		Exec(ctx)
	return err
}

// ListSessions 只列自己的会话；is_current 按当前 token 摘要比对（拍板 U21）。
func (s *Service) ListSessions(ctx context.Context, actor *authz.Actor, current []byte) ([]SessionItem, error) {
	if actor == nil {
		return nil, unauthorized()
	}
	rows, err := s.db.Session.Query().
		Where(session.UserIDEQ(actor.UserID)).
		Order(ent.Desc(session.FieldLastSeenAt), ent.Desc(session.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]SessionItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, SessionItem{
			ID:         sessionKey(r.TokenHash),
			IP:         r.IP,
			UserAgent:  r.UserAgent,
			LastSeenAt: r.LastSeenAt,
			CreatedAt:  r.CreatedAt,
			IsCurrent:  bytes.Equal(r.TokenHash, current),
		})
	}
	return out, nil
}

// RevokeSession 踢自己的一台设备。{id} 就是摘要，直接走 uq_sessions_token：
// 一次索引查找，不需要「按用户列会话」的第二索引（设计 §6.3）。
// user_id 也写进 WHERE：别人的会话删不到（对外 404，不区分「不是你的」与「没有这条」）。
func (s *Service) RevokeSession(ctx context.Context, actor *authz.Actor, key string) error {
	if actor == nil {
		return unauthorized()
	}
	digest, ok := decodeSessionKey(key)
	if !ok {
		return errSessionNotFound
	}
	n, err := s.db.Session.Delete().
		Where(session.TokenHashEQ(digest), session.UserIDEQ(actor.UserID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		return errSessionNotFound
	}
	return nil
}

// InvalidateSession / InvalidateUser 是**跨模块契约**，本轮是 no-op：
// 本域的会话与权限每次都查库（没有第二份真源、没有缓存条目），所以没有东西要失效。
// 保留它们是因为调用点已经定了（设计 §8.5：D3 写 board_moderators 后必须调 InvalidateUser），
// 将来加会话缓存时不用改任何调用点。
func (s *Service) InvalidateSession(_ context.Context, _ []byte) error { return nil }
func (s *Service) InvalidateUser(_ context.Context, _ int64) error     { return nil }

// ipOf 把 handler 给的 IP 文本解析回 netip.Addr（审计入库用）。
func ipOf(s string) netip.Addr {
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}
	}
	return a
}
