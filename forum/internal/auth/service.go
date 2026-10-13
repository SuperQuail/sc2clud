package auth

import (
	"context"
	"log/slog"
	"time"

	"forum/internal/config"
	ent "forum/internal/ent"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
)

// Service 是认证 / 会话 / RBAC 的唯一入口。跨模块依赖全部经 deps.go 的小接口注入
// （app 层用 user / mail / captcha 的实现填）。
type Service struct {
	cfg *config.Config
	db  *ent.Client
	clk clock.Clock
	log *slog.Logger

	users   UserLookup
	mail    MailAccounts
	mailer  Mailer
	captcha Captcha
	limiter Limiter
	queue   Queue

	hash  *hasher
	touch *toucher
	codes *attemptGuard
}

// Deps 是 NewService 的外部依赖。用具名结构体而不是十几个位置参数：
// 后者每加一个依赖就要改所有调用点，而 app 层只在一处组装。
type Deps struct {
	Users   UserLookup
	Mail    MailAccounts
	Mailer  Mailer
	Captcha Captcha
	Limiter Limiter
	Queue   Queue
	Log     *slog.Logger
	// TouchFlush 是测试用的钩子：默认写库（设计 §6.5 的两条批量 UPDATE）。
	TouchFlush func(ctx context.Context, pairs []TouchPair) error
}

// TouchPair 是一次会话活跃时间的刷新（摘要 + 观测到的时刻）。
type TouchPair struct {
	Digest []byte
	Seen   time.Time
}

func NewService(cfg *config.Config, dbc *ent.Client, clk clock.Clock, d Deps) (*Service, error) {
	log := d.Log
	if log == nil {
		log = slog.Default()
	}
	h := newHasher(argon2Params{
		Time:    cfg.Auth.Argon2Time,
		Memory:  cfg.Auth.Argon2MemoryKB,
		Threads: cfg.Auth.Argon2Threads,
		KeyLen:  cfg.Auth.Argon2KeyLen,
	}, cfg.Auth.Argon2MaxConcur, cfg.Auth.Argon2WaitTimeout, log)
	s := &Service{
		cfg: cfg, db: dbc, clk: clk, log: log,
		users: d.Users, mail: d.Mail, mailer: d.Mailer, captcha: d.Captcha,
		limiter: d.Limiter, queue: d.Queue, hash: h, codes: newAttemptGuard(),
	}
	s.touch = newToucher(clk, cfg.Auth.TouchInterval, cfg.Auth.RenewInterval, cfg.Auth.SessionTTL, s.flushTouch)
	if d.TouchFlush != nil {
		s.touch.flush = d.TouchFlush
	}
	return s, nil
}

// withTx 是 platform/db.WithTx 的包装：本域所有多表写都走它（拍板 §5.4）。
// 事务里只做数据库读写与 EnqueueTx——禁止发 HTTP / 发邮件 / 落盘 / Queue.Enqueue。
func (s *Service) withTx(ctx context.Context, fn func(tx *ent.Tx) error) error {
	return db.WithTx(ctx, s.db, fn)
}

// StartTouch 起批量刷写 goroutine；ctx 取消时把在途的写完再返回。
func (s *Service) StartTouch(ctx context.Context) error { return s.touch.run(ctx) }

// ── 请求 / 响应体（本域定义，别的模块不需要它们） ──────────────────────────

// RegisterInput 是注册入参。IP 由 handler 从 c.ClientIP() 取（不从 context 捞）。
type RegisterInput struct {
	Username      string
	Email         string
	Password      string
	Nickname      string
	CaptchaID     string
	CaptchaAnswer string
	IP            string
}

// RegisterResult 是注册响应。**不发会话、不自动登录**（设计 §7.1）：
// 邮箱未必是真的，先给会话等于一个假邮箱换一个可写会话。
type RegisterResult struct {
	ID            string `json:"id"`
	Handle        string `json:"handle"`
	EmailVerified bool   `json:"email_verified"`
	// AutoActivate 告诉前端注册后该显示哪一页（拍板 §12.2）：
	// true → 「验证码已发到邮箱」+ 重发按钮；false → 「等待管理员激活」+ **不显示**重发按钮。
	AutoActivate bool `json:"auto_activate"`
}

// LoginInput 的 Login 同时接受登录名与邮箱（不新增端点）。
type LoginInput struct {
	Login         string
	Password      string
	CaptchaID     string
	CaptchaAnswer string
	IP            string
	UserAgent     string
}

// LoginResult 给 handler 用来 Set-Cookie；token 不出 service。
type LoginResult struct {
	Token     string
	ExpiresAt time.Time
}

// MeResult 是 GET /me 的响应。
type MeResult struct {
	ID            string          `json:"id"`
	Handle        string          `json:"handle"`
	Nickname      string          `json:"nickname"`
	Email         string          `json:"email"`
	Avatar        string          `json:"avatar"`
	AvatarSmall   string          `json:"avatar_small"`
	Bio           string          `json:"bio"`
	Status        string          `json:"status"`
	EmailVerified bool            `json:"email_verified"`
	Activated     bool            `json:"activated"`
	AutoActivate  bool            `json:"auto_activate"`
	Trusted       bool            `json:"trusted"`
	Level         int             `json:"level"`
	Exp           int             `json:"exp"`
	ExpMax        int             `json:"exp_max"`
	Role          RoleItem        `json:"role"`
	Perms         []string        `json:"perms"`
	Extra         []ExtraPermItem `json:"extra"`
	BoardIDs      []int64         `json:"board_ids"`
	CreatedAt     time.Time       `json:"created_at"`
}

// ExtraPermItem 是一条点对点追加的权限（/me 的展示字段）。
type ExtraPermItem struct {
	Key       string     `json:"key"`
	ExpiresAt *time.Time `json:"expires_at"`
}

// ExtraPerm 是 Principal 内部携带的追加权限（值语义，不跟 JSON 形状绑死）。
type ExtraPerm struct {
	Key       string
	ExpiresAt *time.Time
}

// RoleItem 是角色的对外形状。
type RoleItem struct {
	ID          int64    `json:"id"`
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Depth       int      `json:"depth"`
	BadgeColor  string   `json:"badge_color"`
	IsSystem    bool     `json:"is_system"`
	IsSuper     bool     `json:"is_super"`
	Priority    int      `json:"priority"`
	PermKeys    []string `json:"perm_keys"`
	UserCount   int      `json:"user_count"`
}

// PermItem 是权限点的对外形状（后台勾选界面用）。
type PermItem struct {
	Key         string `json:"key"`
	Group       string `json:"group"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// SessionItem 是 GET /me/sessions 的一行。**不回 token、不回 token_hash**（拍板 U21）。
type SessionItem struct {
	ID         string    `json:"id"`
	IP         string    `json:"ip"`
	UserAgent  string    `json:"user_agent"`
	LastSeenAt time.Time `json:"last_seen_at"`
	CreatedAt  time.Time `json:"created_at"`
	IsCurrent  bool      `json:"is_current"`
}

// 三根状态轴的取值（users.status）。
const (
	StatusActive  = "active"
	StatusBanned  = "banned"
	StatusDeleted = "deleted"
)

// 邮箱验证码 / 重置票据的用途（email_tokens.purpose，迁移里有 CHECK）。
const (
	purposeVerify = "verify"
	purposeReset  = "reset"
)

// codeTTL 是两个 purpose 的有效期（拍板 §11.4：都是 10 分钟）。
const codeTTL = 10 * time.Minute

// maxCodeAttempts 是单码最多试错次数：第 5 次失败即作废（拍板 §11.4）。
const maxCodeAttempts = 5

// ExpMax 是下一级门槛：level * level * 100（设计 §12）。auth 与 user 各有一份同源实现，
// 两处都只**显示**它——写 exp/level 的是 title 模块。
func ExpMax(level int) int { return level * level * 100 }
