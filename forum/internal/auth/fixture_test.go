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
	}
	for _, opt := range opts {
		opt(&d)
	}
	svc, err := NewService(cfg, client, clk, d)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	f := &fixture{t: t, ctx: ctx, pool: pool, db: client, svc: svc, cfg: cfg, clk: clk, sent: sent}
	f.queue, _ = d.Queue.(*fakeQueue)
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
	err := f.pool.QueryRow(f.ctx,
		"INSERT INTO users (public_id, username, email, password_hash, nickname, role_id, status, activated_at) "+
			"VALUES (gen_random_uuid(), $1, $2, $3, $1, $4, 'active', $5) RETURNING id",
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

// stdsqlOf 把 pgx 池包成 database/sql 的 *sql.DB：全库自检（CheckForeignKeys）要这个形状。
func stdsqlOf(pool *pgxpool.Pool) *sql.DB {
	return stdlib.OpenDBFromPool(pool)
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
