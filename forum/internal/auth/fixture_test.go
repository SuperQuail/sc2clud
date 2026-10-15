package auth

// 集成测试的共享夹具：真 PG + 每用例独立 schema（拍板 §5.8）。
// 建表用 client.Schema.Create（拍板 §5.8 明文允许），所以不需要跑迁移。
//
// 三处与迁移的差异必须在建表后补上，否则测的不是真库的形状：
//  1. 迁移有 uq_roles_super（部分唯一索引），ent 表达不了；
//  2. 迁移有 uq_email_tokens_live（同上）；
//  3. email_tokens 在本轮 schema 里**没有** attempt_count / last_attempt_at 两列，
//     而设计 §5.3 要求它们——本实现把试错计数放在进程内（见 email.go 的说明），
//     夹具也不补列：补了反而掩盖这件事，Lead 拍板补列时这两条测试会跟着变。

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	"forum/internal/config"
	ent "forum/internal/ent"
	"forum/internal/platform/clock"
	"forum/internal/platform/queue"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// fixture 是一次用例的全部依赖。
type fixture struct {
	t     *testing.T
	ctx   context.Context
	pool  *pgxpool.Pool
	db    *ent.Client
	svc   *Service
	cfg   *config.Config
	clk   *clock.Fake
	queue *fakeQueue
	sent  *sentCodes
	// set 是站点设置替身：D29 的手动激活开关走它（keyAutoActivate）
	set *settingsStub
}

// sentCodes 收集 Mailer 发出去的明文验证码：测试要拿它去校验。
// 这**不是**生产路径的一部分——生产里码只进邮件正文，不进日志、不进响应体。
type sentCodes struct {
	last atomic.Value
}

func (s *sentCodes) put(code string) { s.last.Store(code) }

func (s *sentCodes) get(t *testing.T) string {
	t.Helper()
	v := s.last.Load()
	if v == nil {
		t.Fatal("没有任何验证码被发送过")
	}
	return v.(string)
}

// fakeMailer 占位实现 mail.Mailer：只记录码并返回递增的 mail_log id（不碰 mail_logs 表）。
type fakeMailer struct {
	n    atomic.Int64
	sent *sentCodes
}

func (m *fakeMailer) SendVerifyCode(_ context.Context, _ int64, _ string, code, _ string) (int64, error) {
	m.sent.put(code)
	return m.n.Add(1), nil
}

// fakeQueue 记录入队的任务：测试断言「注册与重发都投了 mail:send」。
type fakeQueue struct {
	mu    sync.Mutex
	tasks []queue.Task
}

func (q *fakeQueue) Enqueue(_ context.Context, t queue.Task) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tasks = append(q.tasks, t)
	return nil
}

func (q *fakeQueue) count() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.tasks)
}

// allowAll 恒放行。窗口计数依赖真实时间，clock.Fake 管不到它，
// 所以限流本身不在这里测；要证明限流接上了就换成 denyAll。
type allowAll struct{}

func (allowAll) Allow(context.Context, string, int, time.Duration) (bool, time.Duration, error) {
	return true, 0, nil
}

// denyAll 恒拒绝：用来证明限流真的在路径上。
type denyAll struct{}

func (denyAll) Allow(context.Context, string, int, time.Duration) (bool, time.Duration, error) {
	return false, 7 * time.Second, nil
}

// settingsStub 是站点设置的替身：只回答「注册后自动激活」这一个键（D29）。
// 没被设置过（set=false）就按**没这个键**处理 —— 与 site.Service 吃到未声明键时一样，
// 由 auth 回落到配置默认值，这样既有用例（只改 cfg）照旧成立。
type settingsStub struct {
	set   bool
	value bool
}

func (s *settingsStub) Setting(_ context.Context, key string) string {
	if key != keyAutoActivate || !s.set {
		return "" // 没设过 = 这个键在这个部署里没有值 -> auth 回落配置默认（与 site 的未声明键同形）
	}
	if s.value {
		return "on"
	}
	return "off"
}

// noMailAccounts 让注册落进 manual 分支（拍板 §9.5）。
type noMailAccounts struct{}

func (noMailAccounts) HasUsable(context.Context) (bool, error) { return false, nil }

// yesMailAccounts 让注册落进 email 分支。
type yesMailAccounts struct{}

func (yesMailAccounts) HasUsable(context.Context) (bool, error) { return true, nil }

// newFixture 起一个用例：独立 schema + 建表 + 补两条迁移里才有的唯一索引 + 组装 Service。
func newFixture(t *testing.T, opts ...func(*Deps)) *fixture {
	t.Helper()
	ctx, pool := testsupport.Pool(t)

	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })
	if err := client.Schema.Create(ctx); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	mustExec(t, ctx, pool, "CREATE UNIQUE INDEX uq_roles_super ON roles (is_super) WHERE is_super")
	mustExec(t, ctx, pool, "CREATE UNIQUE INDEX uq_email_tokens_live ON email_tokens (user_id, purpose) WHERE used_at IS NULL")
	// 第四处：迁移 0051 给 board_moderators 加了 grown_at（版主任期的「已卸任」标记），
	// 并把 ent 那条 UNIQUE (board_id,user_id) 换成 WHERE grown_at IS NULL 的部分唯一索引。
	// ent 的 schema 里没有这一列（不重新生成 ent 生成代码），所以夹具按迁移的形状补上 ——
	// 少了它，ResolveSession / LoadActor 里那句 grown_at IS NULL 会直接报 42703
	// （2026-10-14 实测：整个 auth 包的会话用例全红）。
	mustExec(t, ctx, pool, "ALTER TABLE board_moderators ADD COLUMN IF NOT EXISTS grown_at timestamptz NULL")
	mustExec(t, ctx, pool, "DROP INDEX IF EXISTS boardmoderator_board_id_user_id")
	mustExec(t, ctx, pool, "CREATE UNIQUE INDEX IF NOT EXISTS uq_board_moderators_active ON board_moderators (board_id, user_id) WHERE grown_at IS NULL")
	// 0051 还补了 board_id 的单列索引：上面那条部分唯一索引**不算** FK 的可用索引
	// （RI 查找用不了带谓词的索引），少了它 CheckForeignKeys 会红（2026-10-14 实测）。
	mustExec(t, ctx, pool, "CREATE INDEX IF NOT EXISTS idx_board_moderators_board ON board_moderators (board_id)")

	cfg := config.Default()
	cfg.Site.CookieName = "forum_session"
	cfg.Site.BaseURL = "http://127.0.0.1:8081"
	cfg.Auth.Argon2MemoryKB = 8192 // 测试里降到最小合法值：32MB 会让每个用例慢几百毫秒
	cfg.Auth.Argon2Time = 1
	cfg.Auth.SessionTTL = 720 * time.Hour
	cfg.Auth.TouchInterval = 10 * time.Minute
	cfg.Auth.RenewInterval = 24 * time.Hour

	clk := &clock.Fake{T: time.Date(2026, 10, 13, 4, 0, 0, 0, time.UTC)}
	sent := &sentCodes{}
	d := Deps{
		Mail:    yesMailAccounts{},
		Mailer:  &fakeMailer{sent: sent},
		Limiter: allowAll{},
		Queue:   &fakeQueue{},
		Log:     slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})),
		// 站点设置默认**开着**（与 config.Default() 的默认值一致，所以既有用例一条都不变）。
		// 要测开关就改 f.set.value；要测「这个键在这个部署里没有」就改 f.set.set=false。
		Settings: &settingsStub{set: true, value: true},
	}
	for _, opt := range opts {
		opt(&d)
	}
	if d.Users == nil {
		d.Users = userLookupStub{q: client}
	}
	svc, err := NewService(cfg, client, clk, d)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	f := &fixture{t: t, ctx: ctx, pool: pool, db: client, svc: svc, cfg: cfg, clk: clk, sent: sent}
	f.queue, _ = d.Queue.(*fakeQueue)
	f.set, _ = d.Settings.(*settingsStub)
	return f
}

func mustExec(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("执行 SQL 失败 (%s): %v", sql, err)
	}
}

// seedRBAC 灌四个角色 + 24 个权限点 + 勾选矩阵（数值与 0017_seed_authz 一致）。
func (f *fixture) seedRBAC() {
	f.t.Helper()
	for _, r := range []struct {
		key, name string
		isSuper   bool
		priority  int
	}{
		{"user", "普通用户", false, 0},
		{"creator", "认证创作者", false, 1},
		{"admin", "管理员", false, 2},
		{"superadmin", "超级管理员", true, 3},
	} {
		mustExec(f.t, f.ctx, f.pool,
			"INSERT INTO roles (key, name, depth, is_system, is_super, priority) VALUES ($1,$2,$3,true,$4,$5)",
			r.key, r.name, r.priority, r.isSuper, r.priority)
	}
	for _, k := range authz.All {
		mustExec(f.t, f.ctx, f.pool,
			"INSERT INTO permissions (key, grp, name, description) VALUES ($1,$2,$1,'')", k, "topic")
	}
	grants := map[string]string{
		"user":       "topic.create,topic.edit.own,topic.delete.own",
		"creator":    "topic.create,topic.edit.own,topic.delete.own,topic.lock,topic.move,topic.pin,resource.publish",
		"admin":      "topic.create,topic.edit.own,topic.delete.own,topic.lock,topic.move,topic.pin,topic.delete.any,board.manage,board.moderate,post.review,report.handle,reward.verify,title.grant,title.manage,user.ban,user.mute",
		"superadmin": strings.Join(authz.All, ","),
	}
	for roleKey, list := range grants {
		mustExec(f.t, f.ctx, f.pool,
			"INSERT INTO role_permissions (role_id, permission_id) "+
				"SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = $1 AND p.key = ANY($2::text[])",
			roleKey, strings.Split(list, ","))
	}
}

// newUser 直接插一行用户（绕开注册，用来单独测别的路径）。
func (f *fixture) newUser(username, password, roleKey string) int64 {
	f.t.Helper()
	return f.newUserRow(username, password, roleKey, true)
}

// newUserRow 的 activate=false 用来造「未激活」用户。
func (f *fixture) newUserRow(username, password, roleKey string, activate bool) int64 {
	f.t.Helper()
	var id int64
	var activated any
	if activate {
		activated = f.clk.Now()
	}
	// activate=true 时两根轴一起置：email_verified_at 只影响展示（拍板 §9.12），
	// 但「重发验证码」这条路径判的正是它，所以显式区分。
	err := f.pool.QueryRow(f.ctx,
		"INSERT INTO users (public_id, username, email, password_hash, nickname, role_id, status, email_verified_at, activated_at) "+
			"VALUES (gen_random_uuid(), $1, $2, $3, $1, $4, 'active', $5, $5) RETURNING id",
		username, username+"@example.com", f.hashPassword(password), f.roleID(roleKey), activated).Scan(&id)
	if err != nil {
		f.t.Fatalf("插用户失败: %v", err)
	}
	return id
}

func (f *fixture) roleID(key string) int64 {
	f.t.Helper()
	var id int64
	if err := f.pool.QueryRow(f.ctx, "SELECT id FROM roles WHERE key = $1", key).Scan(&id); err != nil {
		f.t.Fatalf("取角色 %s 失败: %v", key, err)
	}
	return id
}

func (f *fixture) hashPassword(pw string) string {
	f.t.Helper()
	if err := f.svc.hash.acquire(f.ctx); err != nil {
		f.t.Fatalf("取哈希信号量失败: %v", err)
	}
	defer f.svc.hash.release()
	phc, err := f.svc.hash.Hash(pw)
	if err != nil {
		f.t.Fatalf("哈希失败: %v", err)
	}
	return phc
}

// ptrBool 取布尔地址：config.Auth.AutoActivate 是 *bool，nil = 用默认（true）。
func ptrBool(v bool) *bool { return &v }

// stdsqlOf 把 pgx 池包成 database/sql 的 *sql.DB：全库自检（CheckForeignKeys）要这个形状。
func stdsqlOf(pool *pgxpool.Pool) *sql.DB {
	return stdlib.OpenDBFromPool(pool)
}

// userLookupStub 是本域测试用的 UserLookup 实现。
//
// 生产里这个接口由 internal/user.Service 实现（app 层注入）。测试**不能** import 它：
// internal/user 反过来 import 本域的类型（auth.UserAuthRow），在 *_test.go 里引它会形成
// 测试依赖环。所以在测试里用同一份 SQL（auth/pgsql.FindUserByLogin，就是生产用的那条）
// 走一遍，测的仍然是真库真查询。**接线本身的测试**放在 internal/app。
type userLookupStub struct{ q pgsql.Querier }

func (u userLookupStub) GetAuthRow(ctx context.Context, login string) (*UserAuthRow, error) {
	row, found, err := pgsql.FindUserByLogin(ctx, u.q, login)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrUserNotFound
	}
	return &UserAuthRow{
		ID: row.ID, PublicID: row.PublicID, Username: row.Username, Email: row.Email,
		PasswordHash: row.PasswordHash, Nickname: row.Nickname, Status: row.Status,
		EmailVerifiedAt: row.EmailVerifiedAt, ActivatedAt: row.ActivatedAt,
		Trusted: row.Trusted, RoleID: row.RoleID, RoleKey: row.RoleKey, IsSuper: row.IsSuper,
	}, nil
}

func (u userLookupStub) GetBasic(ctx context.Context, userID int64) (UserBasic, error) {
	var b UserBasic
	err := pgsql.QueryRow(ctx, u.q,
		"SELECT id, public_id, username, nickname, COALESCE(avatar_hash,''), COALESCE(avatar_small_hash,''), status "+
			"FROM users WHERE id = $1", userID).
		Scan(&b.ID, &b.PublicID, &b.Handle, &b.Nickname, &b.AvatarHash, &b.AvatarSmall, &b.Status)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return UserBasic{}, ErrUserNotFound
		}
		return UserBasic{}, err
	}
	return b, nil
}

// login 走真实登录拿 token（顺带证明注册/登录链路能跑）。
func (f *fixture) login(login, password string) string {
	f.t.Helper()
	out, err := f.svc.Login(f.ctx, LoginInput{Login: login, Password: password, IP: "127.0.0.1"})
	if err != nil {
		f.t.Fatalf("登录失败: %v", err)
	}
	return out.Token
}

func (f *fixture) actor(token string) *authz.Actor {
	f.t.Helper()
	p, err := f.svc.Resolve(f.ctx, token)
	if err != nil {
		f.t.Fatalf("解析会话失败: %v", err)
	}
	return p.Actor()
}

// login 的姊妹方法：注册后直接登录（测试里很常用）。
// pgsqlResolve / pgsqlLoadActor 是排查用的薄包装（测试内可见）。
func pgsqlResolve(f *fixture, digest []byte) (*pgsql.SessionRow, error) {
	return pgsql.ResolveSession(f.ctx, f.db, digest, f.clk.Now())
}

func pgsqlLoadActor(f *fixture, roleID, userID int64) (*pgsql.ActorRow, error) {
	return pgsql.LoadActor(f.ctx, f.db, roleID, userID, f.clk.Now())
}
