package mail

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/testsupport"
)

// 0018 是本轮唯一新增的迁移：必须能跑、能回滚，而且两边的形状要对得上。
//
// 这条用例同时是「迁移文件本身可用」的那组测试（拍板 §5.8）在平台层的落点。
func TestMigration0018UpAndDown(t *testing.T) {
	ctx, base := testsupport.Pool(t)
	schema := base.Config().ConnConfig.RuntimeParams["search_path"]
	if schema == "" {
		t.Fatal("testsupport 的池没有 search_path")
	}
	mcfg, err := pgxpool.ParseConfig(testsupport.DSN())
	if err != nil {
		t.Fatal(err)
	}
	// 简单协议：迁移文件一个文件多条语句。
	mcfg.ConnConfig.DefaultQueryExecMode = 2 // pgx.QueryExecModeSimpleProtocol
	mcfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, mcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// 0018 依赖 users（0002）与 mail_accounts（0014）。
	applyMigrations(t, ctx, pool)

	// ---- up：表在、列齐、reply_scope 只认 all/none、user_id 唯一 ----
	for _, col := range []string{"id", "user_id", "alert", "reply_scope", "mention_scope", "like_alert", "created_at", "updated_at"} {
		var n int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name = 'user_notice_settings' AND column_name = $2`,
			schema, col).Scan(&n)
		if err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("user_notice_settings 缺列 %s", col)
		}
	}

	uid := newUserRow(t, ctx, pool, "notice1")
	if _, err := pool.Exec(ctx, "INSERT INTO user_notice_settings (user_id) VALUES ($1)", uid); err != nil {
		t.Fatalf("插入默认行: %v", err)
	}
	var alert, likeAlert bool
	var reply, mention string
	if err := pool.QueryRow(ctx, "SELECT alert, reply_scope, mention_scope, like_alert FROM user_notice_settings WHERE user_id = $1", uid).
		Scan(&alert, &reply, &mention, &likeAlert); err != nil {
		t.Fatal(err)
	}
	if !alert || !likeAlert || reply != "all" || mention != "all" {
		t.Fatalf("默认值不对: alert=%v reply=%q mention=%q like=%v", alert, reply, mention, likeAlert)
	}

	// followed 必须被 CHECK 拒掉（拍板 §8.3 把它删了：本产品没有关注功能）。
	_, err = pool.Exec(ctx, "UPDATE user_notice_settings SET reply_scope = 'followed' WHERE user_id = $1", uid)
	if err == nil || !strings.Contains(err.Error(), "ck_user_notice_settings_reply_scope") {
		t.Fatalf("reply_scope='followed' 必须被 CHECK 拒绝，实际 %v", err)
	}

	// user_id 是 UNIQUE：一行一人。
	uid2 := newUserRow(t, ctx, pool, "notice2")
	if _, err := pool.Exec(ctx, "INSERT INTO user_notice_settings (user_id) VALUES ($1)", uid); err == nil {
		t.Fatal("同一个 user 插第二行应当被唯一约束拒绝")
	}
	if _, err := pool.Exec(ctx, "INSERT INTO user_notice_settings (user_id) VALUES ($1)", uid2); err != nil {
		t.Fatalf("另一个 user 应当能插: %v", err)
	}

	// ---- mail_accounts.provider 收进了 log ----
	acct := newAccount(t, ctx, pool, "log-account", "log")
	if acct == 0 {
		t.Fatal("provider='log' 的账号应当能建")
	}

	// ---- down：表没了、log 账号没了、值域收回 resend/smtp ----
	applyDown(t, ctx, pool, "0018_notice_settings.down.sql")
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('user_notice_settings') IS NOT NULL").Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("回滚后 user_notice_settings 必须消失")
	}
	var logCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM mail_accounts WHERE provider = 'log'").Scan(&logCount); err != nil {
		t.Fatal(err)
	}
	if logCount != 0 {
		t.Fatalf("回滚必须清掉 log 账号（否则约束加不回去），实际还剩 %d 个", logCount)
	}
	// 值域收回后 resend 仍然可建。
	if newAccount(t, ctx, pool, "resend-account", "resend") == 0 {
		t.Fatal("回滚后 provider='resend' 应当仍然合法")
	}
}

func applyDown(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testsupport.MigrationsDir(), name))
	if err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		sb.WriteString(line)
		sb.WriteByte(10)
	}
	if _, err := pool.Exec(ctx, sb.String()); err != nil {
		t.Fatalf("回滚 %s: %v", name, err)
	}
}

func newUserRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	key := name + "-role"
	if _, err := pool.Exec(ctx, "INSERT INTO roles (key, name, is_system) VALUES ($1, $1, true) ON CONFLICT (key) DO NOTHING", key); err != nil {
		t.Fatalf("建角色: %v", err)
	}
	var id int64
	err := pool.QueryRow(ctx, `
INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
VALUES (gen_random_uuid(), $1, $2, 'x', $1, (SELECT id FROM roles WHERE key = $3))
RETURNING id`, name, name+"@t", key).Scan(&id)
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	return id
}

func newAccount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name, provider string) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
INSERT INTO mail_accounts (public_id, name, provider, from_address)
VALUES (gen_random_uuid(), $1, $2, 'no-reply@example.com') RETURNING id`, name, provider).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "ck_mail_accounts_provider") {
			return 0
		}
		t.Fatalf("建账号 %s: %v", name, err)
	}
	return id
}
