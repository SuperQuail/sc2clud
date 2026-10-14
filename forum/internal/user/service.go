// Package user 是公开资料（个人主页 + @ 提及的前缀候选）。
//
// 它是**纯读模块**：users 表的唯一写者是 internal/auth（设计 §4.1），本模块一行 UPDATE 都没有。
// 它同时实现 auth 的 deps.UserLookup（GetAuthRow / GetBasic），由 app 层注入。
package user

import (
	"context"
	"strings"
	"time"

	"forum/internal/auth"
	"forum/internal/auth/pgsql"
	ent "forum/internal/ent"
	"forum/internal/ent/user"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	userpgsql "forum/internal/user/pgsql"
)

// AvatarURL 由 media 实现（U12/U15/U20 定案）：
//   - 本模块只回**完整路径**（/img/<hash>），前端直接当 src 用；
//   - hash 为空时返回池子里分到的那张；池子为空返回空串（前端显示首字母占位）。
type AvatarURL interface {
	Avatar(ctx context.Context, userID int64, hash, smallHash, defaultHash string) (avatar, avatarSmall string)
	// Cover 拼封面路径（users.cover_hash，0030）。与 Avatar 同一个实现者（media），
	// 所以是**同一个接口里的第二个方法**而不是一个新接口：多一个接口就多一处接线要记得传。
	Cover(hash string) string
}

// Config 是本模块的两个上限（设计 §4.3 的 user.* 段）。
type Config struct {
	NicknameMax int
	ProfileMax  int
}

// Service 是公开资料的读入口。
type Service struct {
	cfg     *Config
	db      *ent.Client
	avatars AvatarURL
	clk     clock.Clock
}

func NewService(db *ent.Client, avatars AvatarURL, clk clock.Clock, cfg Config) *Service {
	if cfg.NicknameMax <= 0 {
		cfg.NicknameMax = 20
	}
	if cfg.ProfileMax <= 0 {
		cfg.ProfileMax = 200
	}
	return &Service{cfg: &cfg, db: db, avatars: avatars, clk: clk}
}

// Profile 是个人主页的响应体（设计 §11.2）。
type Profile struct {
	ID          string `json:"id"`
	Handle      string `json:"handle"`
	Nickname    string `json:"nickname"`
	Avatar      string `json:"avatar"`
	AvatarSmall string `json:"avatar_small"`
	// Cover 是个人主页的封面 / 背景（0030 的 users.cover_hash）。空串 = 没设过，前端走默认站内素材。
	Cover        string     `json:"cover"`
	Bio          string     `json:"bio"`
	Status       string     `json:"status"`
	Level        int        `json:"level"`
	Exp          int        `json:"exp"`
	ExpMax       int        `json:"exp_max"`
	TopicCount   int        `json:"topic_count"`
	LikeReceived int        `json:"like_received"`
	JoinedAt     time.Time  `json:"joined_at"`
	Title        *TitleItem `json:"title"`
}

// TitleItem 只给**佩戴中**的那一个头衔；持有的全部在 title 模块的端点里。
type TitleItem struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

// SearchItem 是 @ 提及候选的一行。
type SearchItem struct {
	ID        string `json:"id"`
	Handle    string `json:"handle"`
	Nickname  string `json:"nickname"`
	Avatar    string `json:"avatar"`
	Level     int    `json:"level"`
	Ambiguous bool   `json:"ambiguous"`
}

// GetProfile 按 handle（= username）取公开资料，大小写不敏感。
// status=deleted 返回 404；banned 仍可访问并带上 status（设计 §11.1 末段）。
func (s *Service) GetProfile(ctx context.Context, handle string) (*Profile, error) {
	handle = strings.TrimSpace(handle)
	if handle == "" {
		return nil, apperr.ErrNotFound
	}
	row, found, err := userpgsql.Profile(ctx, s.db, handle)
	if err != nil {
		return nil, err
	}
	if !found || row.Status == "deleted" {
		return nil, apperr.ErrNotFound
	}
	p := &Profile{
		ID: row.PublicID, Handle: row.Username, Nickname: displayName(row.Nickname, row.Username),
		Bio: row.Bio, Status: row.Status,
		Level: row.Level, Exp: row.Exp, ExpMax: ExpMax(row.Level),
		TopicCount: row.TopicCount, LikeReceived: row.LikeReceived,
		JoinedAt: row.CreatedAt,
	}
	if row.TitleName != nil {
		p.Title = &TitleItem{Name: *row.TitleName, Color: deref(row.TitleColor)}
	}
	if s.avatars != nil {
		p.Avatar, p.AvatarSmall = s.avatars.Avatar(ctx, row.ID,
			deref(row.AvatarHash), deref(row.AvatarSmallHash), s.defaultAvatar(ctx, row.ID))
		p.Cover = s.avatars.Cover(deref(row.CoverHash))
	}
	return p, nil
}

// defaultAvatar 取「分一次就固定」的那张（U12：列由 media 写，本模块只读它）。
func (s *Service) defaultAvatar(ctx context.Context, userID int64) string {
	u, err := s.db.User.Query().Where(user.IDEQ(userID)).Select(user.FieldDefaultAvatarHash).Only(ctx)
	if err != nil || u.DefaultAvatarHash == nil {
		return ""
	}
	return *u.DefaultAvatarHash
}

// Search 是 @ 提及的前缀候选：q 长度 1..32、limit 默认 10 上限 20（设计 §11.4）。
func (s *Service) Search(ctx context.Context, q string, limit int) ([]SearchItem, error) {
	q = strings.TrimSpace(q)
	if q == "" || len([]rune(q)) > 32 {
		return nil, apperr.Invalid(map[string]string{"q": "查询词长度必须是 1-32 个字"})
	}
	if limit <= 0 {
		limit = 10
	}
	if limit > 20 {
		limit = 20
	}
	rows, err := userpgsql.Search(ctx, s.db, q, limit)
	if err != nil {
		return nil, err
	}
	out := make([]SearchItem, 0, len(rows))
	for _, r := range rows {
		it := SearchItem{
			ID: r.PublicID, Handle: r.Username, Nickname: displayName(r.Nickname, r.Username),
			Level: r.Level, Ambiguous: r.Ambiguous,
		}
		if s.avatars != nil {
			it.Avatar, _ = s.avatars.Avatar(ctx, 0, deref(r.AvatarHash), deref(r.AvatarSmallHash), "")
		}
		out = append(out, it)
	}
	return out, nil
}

// ── 实现 auth.deps.UserLookup ─────────────────────────────────────

// GetAuthRow 按 username 或 email 定位账号（登录与注册用）。
// SQL 在 auth/pgsql 里，是 lower(col) = lower($1) 的写法真源，两个模块共用同一份（设计 §11.3）。
func (s *Service) GetAuthRow(ctx context.Context, login string) (*auth.UserAuthRow, error) {
	row, found, err := pgsql.FindUserByLogin(ctx, s.db, login)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, auth.ErrUserNotFound
	}
	return &auth.UserAuthRow{
		ID: row.ID, PublicID: row.PublicID, Username: row.Username, Email: row.Email,
		PasswordHash: row.PasswordHash, Nickname: row.Nickname, Status: row.Status,
		EmailVerifiedAt: row.EmailVerifiedAt, ActivatedAt: row.ActivatedAt,
		Trusted: row.Trusted, RoleID: row.RoleID, RoleKey: row.RoleKey, IsSuper: row.IsSuper,
	}, nil
}

// GetBasic 取展示字段（会话解析、通知、审计都用得到）。
func (s *Service) GetBasic(ctx context.Context, userID int64) (auth.UserBasic, error) {
	u, err := s.db.User.Query().Where(user.IDEQ(userID)).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return auth.UserBasic{}, auth.ErrUserNotFound
		}
		return auth.UserBasic{}, err
	}
	return auth.UserBasic{
		ID: u.ID, PublicID: u.PublicID.String(), Handle: u.Username,
		Nickname:   displayName(u.Nickname, u.Username),
		AvatarHash: deref(u.AvatarHash), AvatarSmall: deref(u.AvatarSmallHash), Status: u.Status,
	}, nil
}

// displayName 是**显示名回落**的唯一实现：昵称留空 → 显示登录名。
// 它只作用于响应，**不写回 users.nickname**（留空就是留空，见 d2-auth §5.1 与
// 拍板 U20：nickname 只有 PATCH /me 能写，且写空串会被拒）。
func displayName(nickname, username string) string {
	if strings.TrimSpace(nickname) == "" {
		return username
	}
	return nickname
}

// ExpMax 与 auth 的公式同源：(level+1)^2 * 100（设计 §12：下一级门槛）。
func ExpMax(level int) int { return (level + 1) * (level + 1) * 100 }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
