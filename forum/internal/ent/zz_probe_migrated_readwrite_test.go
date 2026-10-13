package ent

// 一次性探针：在「真跑过 17 份迁移」的库里，让每个 ent 实体各走一遍真实的读 / 写路径。
// 写路径在事务里跑完即回滚，所以它不改变任何持久化状态。
//
// 为什么需要它：迁移与 ent schema 是两条独立的 DDL 路径。二者不一致时
//   * 写路径可能恰好不报（id 为 nil 会被省略）；
//   * 读路径会生成 SELECT <列>，于是报 column does not exist。
// 只有真库真跑才看得见。

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestZZProbeMigratedReadWrite(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	port := uint32(57311)
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Port(port).DataPath(dir+"/data").RuntimePath(dir+"/rt").BinariesPath(dir+"/bin").
		Username("forum").Password("forum").Database("forum").
		StartTimeout(180 * time.Second))
	if err := pg.Start(); err != nil { t.Fatalf("start pg: %v", err) }
	defer pg.Stop()

	dsn := fmt.Sprintf("postgres://forum:forum@127.0.0.1:%d/forum?sslmode=disable", port)
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil { t.Fatal(err) }
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil { t.Fatal(err) }
	defer pool.Close()

	migDir := "D:/Code/Rust/SC2clud/forum/migrations/postgres"
	names, err := filepath.Glob(migDir + "/*.up.sql")
	if err != nil { t.Fatal(err) }
	sort.Strings(names)
	upFail := 0
	for _, n := range names {
		b, rerr := os.ReadFile(n)
		if rerr != nil { t.Fatal(rerr) }
		if _, eerr := pool.Exec(ctx, string(b)); eerr != nil {
			upFail++
			t.Logf("MIGRATION FAIL %s: %v", filepath.Base(n), eerr)
		}
	}
	{
		var n int
		if qerr := pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'").Scan(&n); qerr != nil { t.Fatalf("count tables: %v", qerr) }
		var cur string
		if qerr := pool.QueryRow(ctx, "SELECT current_database()").Scan(&cur); qerr != nil { t.Fatalf("current_database: %v", qerr) }
		t.Logf("EVIDENCE migrations=%d/%d public_tables=%d database=%s", len(names)-upFail, len(names), n, cur)
	}
	if upFail > 0 { t.Fatalf("迁移没跑通，探针结论无意义") }

	client := NewClient(Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	defer client.Close()

	type readCase struct{ name string; run func(context.Context) error }
	reads := []readCase{
		{"Announcement", func(ctx context.Context) error { _, err := client.Announcement.Query().All(ctx); return err }},
		{"AuditLog", func(ctx context.Context) error { _, err := client.AuditLog.Query().All(ctx); return err }},
		{"Banner", func(ctx context.Context) error { _, err := client.Banner.Query().All(ctx); return err }},
		{"BannerDismissal", func(ctx context.Context) error { _, err := client.BannerDismissal.Query().All(ctx); return err }},
		{"BannerRole", func(ctx context.Context) error { _, err := client.BannerRole.Query().All(ctx); return err }},
		{"Block", func(ctx context.Context) error { _, err := client.Block.Query().All(ctx); return err }},
		{"Board", func(ctx context.Context) error { _, err := client.Board.Query().All(ctx); return err }},
		{"BoardACL", func(ctx context.Context) error { _, err := client.BoardACL.Query().All(ctx); return err }},
		{"BoardModerator", func(ctx context.Context) error { _, err := client.BoardModerator.Query().All(ctx); return err }},
		{"Bookmark", func(ctx context.Context) error { _, err := client.Bookmark.Query().All(ctx); return err }},
		{"DefaultAvatar", func(ctx context.Context) error { _, err := client.DefaultAvatar.Query().All(ctx); return err }},
		{"DonationNoticeDefault", func(ctx context.Context) error { _, err := client.DonationNoticeDefault.Query().All(ctx); return err }},
		{"DonationRecord", func(ctx context.Context) error { _, err := client.DonationRecord.Query().All(ctx); return err }},
		{"EmailToken", func(ctx context.Context) error { _, err := client.EmailToken.Query().All(ctx); return err }},
		{"ExpEvent", func(ctx context.Context) error { _, err := client.ExpEvent.Query().All(ctx); return err }},
		{"Image", func(ctx context.Context) error { _, err := client.Image.Query().All(ctx); return err }},
		{"IssueComment", func(ctx context.Context) error { _, err := client.IssueComment.Query().All(ctx); return err }},
		{"Job", func(ctx context.Context) error { _, err := client.Job.Query().All(ctx); return err }},
		{"Like", func(ctx context.Context) error { _, err := client.Like.Query().All(ctx); return err }},
		{"MailAccount", func(ctx context.Context) error { _, err := client.MailAccount.Query().All(ctx); return err }},
		{"MailLog", func(ctx context.Context) error { _, err := client.MailLog.Query().All(ctx); return err }},
		{"MailQuota", func(ctx context.Context) error { _, err := client.MailQuota.Query().All(ctx); return err }},
		{"Message", func(ctx context.Context) error { _, err := client.Message.Query().All(ctx); return err }},
		{"Notification", func(ctx context.Context) error { _, err := client.Notification.Query().All(ctx); return err }},
		{"NotificationMute", func(ctx context.Context) error { _, err := client.NotificationMute.Query().All(ctx); return err }},
		{"PaymentChannel", func(ctx context.Context) error { _, err := client.PaymentChannel.Query().All(ctx); return err }},
		{"Permission", func(ctx context.Context) error { _, err := client.Permission.Query().All(ctx); return err }},
		{"Post", func(ctx context.Context) error { _, err := client.Post.Query().All(ctx); return err }},
		{"PostIssue", func(ctx context.Context) error { _, err := client.PostIssue.Query().All(ctx); return err }},
		{"Release", func(ctx context.Context) error { _, err := client.Release.Query().All(ctx); return err }},
		{"ReleaseAsset", func(ctx context.Context) error { _, err := client.ReleaseAsset.Query().All(ctx); return err }},
		{"Report", func(ctx context.Context) error { _, err := client.Report.Query().All(ctx); return err }},
		{"Role", func(ctx context.Context) error { _, err := client.Role.Query().All(ctx); return err }},
		{"RolePermission", func(ctx context.Context) error { _, err := client.RolePermission.Query().All(ctx); return err }},
		{"Sanction", func(ctx context.Context) error { _, err := client.Sanction.Query().All(ctx); return err }},
		{"Session", func(ctx context.Context) error { _, err := client.Session.Query().All(ctx); return err }},
		{"SiteDomain", func(ctx context.Context) error { _, err := client.SiteDomain.Query().All(ctx); return err }},
		{"SiteSetting", func(ctx context.Context) error { _, err := client.SiteSetting.Query().All(ctx); return err }},
		{"Title", func(ctx context.Context) error { _, err := client.Title.Query().All(ctx); return err }},
		{"Topic", func(ctx context.Context) error { _, err := client.Topic.Query().All(ctx); return err }},
		{"TopicImage", func(ctx context.Context) error { _, err := client.TopicImage.Query().All(ctx); return err }},
		{"TopicSource", func(ctx context.Context) error { _, err := client.TopicSource.Query().All(ctx); return err }},
		{"User", func(ctx context.Context) error { _, err := client.User.Query().All(ctx); return err }},
		{"UserDonationSetting", func(ctx context.Context) error { _, err := client.UserDonationSetting.Query().All(ctx); return err }},
		{"UserPermission", func(ctx context.Context) error { _, err := client.UserPermission.Query().All(ctx); return err }},
		{"UserTitle", func(ctx context.Context) error { _, err := client.UserTitle.Query().All(ctx); return err }},
	}

	type writeCase struct{ name string; run func(context.Context, *Tx) error }
	writes := []writeCase{
		{"Announcement", func(ctx context.Context, tx *Tx) error { return tx.Announcement.Create().Exec(ctx) }},
		{"AuditLog", func(ctx context.Context, tx *Tx) error { return tx.AuditLog.Create().Exec(ctx) }},
		{"Banner", func(ctx context.Context, tx *Tx) error { return tx.Banner.Create().Exec(ctx) }},
		{"BannerDismissal", func(ctx context.Context, tx *Tx) error { return tx.BannerDismissal.Create().Exec(ctx) }},
		{"BannerRole", func(ctx context.Context, tx *Tx) error { return tx.BannerRole.Create().Exec(ctx) }},
		{"Block", func(ctx context.Context, tx *Tx) error { return tx.Block.Create().Exec(ctx) }},
		{"Board", func(ctx context.Context, tx *Tx) error { return tx.Board.Create().Exec(ctx) }},
		{"BoardACL", func(ctx context.Context, tx *Tx) error { return tx.BoardACL.Create().Exec(ctx) }},
		{"BoardModerator", func(ctx context.Context, tx *Tx) error { return tx.BoardModerator.Create().Exec(ctx) }},
		{"Bookmark", func(ctx context.Context, tx *Tx) error { return tx.Bookmark.Create().Exec(ctx) }},
		{"DefaultAvatar", func(ctx context.Context, tx *Tx) error { return tx.DefaultAvatar.Create().Exec(ctx) }},
		{"DonationNoticeDefault", func(ctx context.Context, tx *Tx) error { return tx.DonationNoticeDefault.Create().Exec(ctx) }},
		{"DonationRecord", func(ctx context.Context, tx *Tx) error { return tx.DonationRecord.Create().Exec(ctx) }},
		{"EmailToken", func(ctx context.Context, tx *Tx) error { return tx.EmailToken.Create().Exec(ctx) }},
		{"ExpEvent", func(ctx context.Context, tx *Tx) error { return tx.ExpEvent.Create().Exec(ctx) }},
		{"Image", func(ctx context.Context, tx *Tx) error { return tx.Image.Create().Exec(ctx) }},
		{"IssueComment", func(ctx context.Context, tx *Tx) error { return tx.IssueComment.Create().Exec(ctx) }},
		{"Job", func(ctx context.Context, tx *Tx) error { return tx.Job.Create().Exec(ctx) }},
		{"Like", func(ctx context.Context, tx *Tx) error { return tx.Like.Create().Exec(ctx) }},
		{"MailAccount", func(ctx context.Context, tx *Tx) error { return tx.MailAccount.Create().Exec(ctx) }},
		{"MailLog", func(ctx context.Context, tx *Tx) error { return tx.MailLog.Create().Exec(ctx) }},
		{"MailQuota", func(ctx context.Context, tx *Tx) error { return tx.MailQuota.Create().Exec(ctx) }},
		{"Message", func(ctx context.Context, tx *Tx) error { return tx.Message.Create().Exec(ctx) }},
		{"Notification", func(ctx context.Context, tx *Tx) error { return tx.Notification.Create().Exec(ctx) }},
		{"NotificationMute", func(ctx context.Context, tx *Tx) error { return tx.NotificationMute.Create().Exec(ctx) }},
		{"PaymentChannel", func(ctx context.Context, tx *Tx) error { return tx.PaymentChannel.Create().Exec(ctx) }},
		{"Permission", func(ctx context.Context, tx *Tx) error { return tx.Permission.Create().Exec(ctx) }},
		{"Post", func(ctx context.Context, tx *Tx) error { return tx.Post.Create().Exec(ctx) }},
		{"PostIssue", func(ctx context.Context, tx *Tx) error { return tx.PostIssue.Create().Exec(ctx) }},
		{"Release", func(ctx context.Context, tx *Tx) error { return tx.Release.Create().Exec(ctx) }},
		{"ReleaseAsset", func(ctx context.Context, tx *Tx) error { return tx.ReleaseAsset.Create().Exec(ctx) }},
		{"Report", func(ctx context.Context, tx *Tx) error { return tx.Report.Create().Exec(ctx) }},
		{"Role", func(ctx context.Context, tx *Tx) error { return tx.Role.Create().Exec(ctx) }},
		{"RolePermission", func(ctx context.Context, tx *Tx) error { return tx.RolePermission.Create().Exec(ctx) }},
		{"Sanction", func(ctx context.Context, tx *Tx) error { return tx.Sanction.Create().Exec(ctx) }},
		{"Session", func(ctx context.Context, tx *Tx) error { return tx.Session.Create().Exec(ctx) }},
		{"SiteDomain", func(ctx context.Context, tx *Tx) error { return tx.SiteDomain.Create().Exec(ctx) }},
		{"SiteSetting", func(ctx context.Context, tx *Tx) error { return tx.SiteSetting.Create().Exec(ctx) }},
		{"Title", func(ctx context.Context, tx *Tx) error { return tx.Title.Create().Exec(ctx) }},
		{"Topic", func(ctx context.Context, tx *Tx) error { return tx.Topic.Create().Exec(ctx) }},
		{"TopicImage", func(ctx context.Context, tx *Tx) error { return tx.TopicImage.Create().Exec(ctx) }},
		{"TopicSource", func(ctx context.Context, tx *Tx) error { return tx.TopicSource.Create().Exec(ctx) }},
		{"User", func(ctx context.Context, tx *Tx) error { return tx.User.Create().Exec(ctx) }},
		{"UserDonationSetting", func(ctx context.Context, tx *Tx) error { return tx.UserDonationSetting.Create().Exec(ctx) }},
		{"UserPermission", func(ctx context.Context, tx *Tx) error { return tx.UserPermission.Create().Exec(ctx) }},
		{"UserTitle", func(ctx context.Context, tx *Tx) error { return tx.UserTitle.Create().Exec(ctx) }},
	}

	var out []string
	failRead, failWrite := 0, 0
	for _, c := range reads {
		if err := c.run(ctx); err != nil {
			failRead++
			out = append(out, "READ_FAIL\t"+c.name+"\t"+oneLine(err.Error()))
		} else {
			out = append(out, "READ_OK\t"+c.name+"\t-")
		}
	}
	for _, c := range writes {
		tx, terr := client.BeginTx(ctx, nil)
		if terr != nil { failWrite++; out = append(out, "WRITE_FAIL\t"+c.name+"\tbegin: "+oneLine(terr.Error())); continue }
		eerr := c.run(ctx, tx)
		_ = tx.Rollback()
		if eerr != nil {
			failWrite++
			out = append(out, "WRITE_FAIL\t"+c.name+"\t"+oneLine(eerr.Error()))
		} else {
			out = append(out, "WRITE_OK\t"+c.name+"\t-")
		}
	}
	sort.Strings(out)
	summary := fmt.Sprintf("PROBE total=%d read_fail=%d write_fail=%d\n%s\n", len(reads)+len(writes), failRead, failWrite, strings.Join(out, "\n"))
	if p := os.Getenv("PROBE_OUT"); p != "" { _ = os.WriteFile(p, []byte(summary), 0o644) }
	t.Log("\n" + summary)
}

func oneLine(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, "\n", " "), "\t", " ") }


// TestZZProbeBusinessSQL 把仓库里的关键业务 SQL 逐字搬进真库做 PREPARE 解析：
// 只要是「列/表不存在」这类不一致，PREPARE 就会报，不需要造数据。
func TestZZProbeBusinessSQL(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	port := uint32(57411)
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Port(port).DataPath(dir+"/data").RuntimePath(dir+"/rt").BinariesPath(dir+"/bin").
		Username("forum").Password("forum").Database("forum").
		StartTimeout(180 * time.Second))
	if err := pg.Start(); err != nil { t.Fatalf("start pg: %v", err) }
	defer pg.Stop()
	dsn := fmt.Sprintf("postgres://forum:forum@127.0.0.1:%d/forum?sslmode=disable", port)
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil { t.Fatal(err) }
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil { t.Fatal(err) }
	defer pool.Close()
	names, _ := filepath.Glob("D:/Code/Rust/SC2clud/forum/migrations/postgres/*.up.sql")
	sort.Strings(names)
	bad := 0
	for _, n := range names {
		b, _ := os.ReadFile(n)
		if _, e := pool.Exec(ctx, string(b)); e != nil { bad++; t.Logf("MIGRATION FAIL %s: %v", filepath.Base(n), e) }
	}
	if bad > 0 { t.Fatalf("迁移没跑通") }
	// 先插一行数据，让 EXPLAIN 有依据
	_, _ = pool.Exec(ctx, "INSERT INTO topics (public_id, board_id, author_id, title) "+
		"SELECT gen_random_uuid(), (SELECT id FROM boards LIMIT 1), (SELECT id FROM users LIMIT 1), 'x' WHERE EXISTS (SELECT 1 FROM boards) AND EXISTS (SELECT 1 FROM users)")

	sqlCases := []struct{ name, sql string }{
		{"worker.claimSQL", "UPDATE jobs SET\n       status       = 'running',\n       locked_until = $1,\n       locked_by    = $2,\n       attempts     = attempts + 1,\n       updated_at   = $1\n WHERE id = (\n       SELECT id FROM jobs\n        WHERE status = 'pending' AND run_at <= $1\n        ORDER BY priority DESC, run_at, id\n        LIMIT 1\n        FOR UPDATE SKIP LOCKED\n )\n RETURNING id, type, payload, attempts, max_retry"},
		{"worker.doneSQL", "UPDATE jobs SET status = 'done', locked_until = NULL, last_error = '', updated_at = $3\n WHERE id = $1 AND locked_by = $2 AND status = 'running'"},
		{"worker.retrySQL", "UPDATE jobs SET\n       status       = 'pending',\n       run_at       = $4::timestamptz + (LEAST($5::double precision * power(2, attempts), $6::double precision) * interval '1 second'),\n       locked_until = NULL,\n       locked_by    = '',\n       last_error   = $3,\n       updated_at   = $4::timestamptz\n WHERE id = $1 AND locked_by = $2 AND status = 'running'"},
		{"worker.deadSQL", "UPDATE jobs SET status = 'dead', locked_until = NULL, locked_by = '', last_error = $3, updated_at = $4\n WHERE id = $1 AND locked_by = $2 AND status = 'running'"},
		{"worker.recoverSQL", "UPDATE jobs SET status = 'pending', locked_until = NULL, locked_by = '', updated_at = $1\n WHERE status = 'running' AND locked_until < $1"},
		{"user.ProfileSQL", "SELECT u.id, u.public_id, u.username, u.nickname, u.bio,\n       u.avatar_hash, u.avatar_small_hash,\n       u.exp, u.level, u.status, u.created_at,\n       t.name AS title_name, t.color AS title_color,\n       COALESCE(tc.n, 0) AS topic_count,\n       COALESCE(lc.n, 0) AS like_received\n  FROM users u\n  LEFT JOIN titles t ON t.id = u.equipped_title_id\n  LEFT JOIN LATERAL (\n        SELECT count(*) AS n FROM topics tp\n         WHERE tp.author_id = u.id AND tp.visibility = 'normal' AND tp.review_state = 'approved'\n       ) tc ON true\n  LEFT JOIN LATERAL (\n        SELECT count(*) AS n\n          FROM likes l JOIN posts p ON p.id = l.target_id AND l.target_type = 'post'\n         WHERE p.author_id = u.id AND p.status = 'normal'\n       ) lc ON true\n WHERE lower(u.username) = lower($1)"},
		{"user.SearchSQL", "SELECT u.public_id, u.username, u.nickname, u.avatar_hash, u.avatar_small_hash, u.level,\n       (count(*) OVER (PARTITION BY lower(u.nickname))) > 1 AS ambiguous\n  FROM users u\n WHERE u.status = 'active'\n   AND (lower(u.username) LIKE lower($1) || '%' OR lower(u.nickname) LIKE lower($1) || '%')\n ORDER BY (lower(u.nickname) = lower($1)) DESC,\n          (lower(u.username) LIKE lower($1) || '%') DESC,\n          u.username ASC\n LIMIT $2"},
		{"release.addDownloadCounts (id 可重复)", "UPDATE release_assets\n   SET download_count = download_count + v.n\n  FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS n) v\n WHERE release_assets.id = v.id"},
		{"pgcounter.updateTopicViewsSQL (无重复时)", "UPDATE topics AS t SET view_count = t.view_count + v.d, updated_at = $3\n  FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS d) AS v\n WHERE t.id = v.id"},
		{"auth.grantPermSQL", "INSERT INTO user_permissions (user_id, permission_id, granted_by, granted_at, expires_at, reason)\n VALUES ($1, $2, $3, $4, $5, $6)\n ON CONFLICT (user_id, permission_id) DO UPDATE\n SET granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at,\n expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason\n RETURNING (xmax = 0)"},
		{"notify.insertSQL", "INSERT INTO notifications (public_id, user_id, actor_id, type, payload, link, dedup_key, created_at)\n VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8)\n ON CONFLICT (user_id, dedup_key) WHERE dedup_key <> '' DO NOTHING"},
		{"notify.markReadSQL", "UPDATE notifications SET read_at = $2\n WHERE user_id = $1 AND read_at IS NULL\n   AND ($3::bool OR public_id = ANY($4::uuid[]))"},
		{"message.insertMessageSQL", "INSERT INTO messages (public_id, low_id, high_id, sender_id, body, created_at)\n VALUES ($1::uuid, LEAST($2::bigint, $3::bigint), GREATEST($2::bigint, $3::bigint), $2::bigint, $4, $5)\n RETURNING public_id::text, created_at"},
		{"title.insertExpEventSQL", "INSERT INTO exp_events (user_id, delta, reason, ref, created_at)\n VALUES ($1, $2, $3, $4, $5)\n ON CONFLICT (user_id, reason, ref) WHERE ref <> '' DO NOTHING\n RETURNING id"},
		{"title.addExpSQL", "UPDATE users\n   SET exp   = exp + $2,\n       level = floor(sqrt((exp + $2) / 100.0))::int + 1,\n       updated_at = $3\n WHERE id = $1\n RETURNING exp, level"},
		{"media.incRefTx", "INSERT INTO images (hash, size, mime, width, height, refcount, visibility, owner_id, created_at, updated_at)\n VALUES ($1, $2, $3, $4, $5, 1, $6, $7, now(), now())\n ON CONFLICT (hash) DO UPDATE\n   SET refcount = images.refcount + 1, updated_at = now()"},
		{"forum.InsertTopic", "INSERT INTO topics (public_id, board_id, author_id, kind, title, excerpt,\n                    review_state, resource_status, client_token,\n                    last_reply_at, created_at, updated_at)\nVALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)\nRETURNING id"},
		{"forum.InsertPost", "INSERT INTO posts (public_id, topic_id, author_id, parent_id, floor,\n                   content_md, content_html, client_token, created_at, updated_at)\nSELECT $1::uuid, $2::bigint, $3::bigint, $4::bigint,\n       COALESCE((SELECT max(floor) FROM posts WHERE topic_id = $2::bigint), 0) + 1,\n       $5::text, $6::text, $7::varchar, $8::timestamptz, $8::timestamptz\nRETURNING id, floor"},
		{"search.exactSQL", "SELECT t.id, t.public_id, t.title, ts_rank(s.tsv, plainto_tsquery('simple', $1)) AS rank\n  FROM topic_search s\n  JOIN topics t ON t.id = s.topic_id\n WHERE s.tsv @@ plainto_tsquery('simple', $1)\n   AND t.visibility   = 'normal'\n   AND t.review_state = 'approved'\n   AND ($2::bigint IS NULL OR t.board_id = $2)\n   AND ($3::real IS NULL OR (ts_rank(s.tsv, plainto_tsquery('simple', $1)), t.id) < ($3::real, $4::bigint))\n ORDER BY rank DESC, t.id DESC\n LIMIT $5"},
		{"search.UpsertTopic", "INSERT INTO topic_search (topic_id, title, body_text, tokens, updated_at)\nVALUES ($1, $2, $3, $4, now())\nON CONFLICT (topic_id) DO UPDATE\n   SET title = EXCLUDED.title, body_text = EXCLUDED.body_text,\n       tokens = EXCLUDED.tokens, updated_at = now()"},
		{"notify.listSQL", "SELECT n.id, n.public_id::text, n.type, n.payload::text, n.link, n.read_at, n.created_at,\n       a.username, a.nickname, a.avatar_hash, a.avatar_small_hash\n  FROM notifications n\n  LEFT JOIN users a ON a.id = n.actor_id AND a.status <> 'deleted'\n WHERE n.user_id = $1\n   AND n.deleted_at IS NULL\n   AND ($2::timestamptz IS NULL OR (n.created_at, n.id) < ($2::timestamptz, $3::bigint))\n   AND ($4::text = '' OR n.type = $4)\n   AND ($5::bool = false OR n.read_at IS NULL)\n ORDER BY n.created_at DESC, n.id DESC\n LIMIT $6"},
		{"pgsql.ListAuditSQL", "SELECT a.id, a.created_at, a.action, a.target_type, a.target_id, a.detail, a.ip,\n       u.public_id, u.username, u.nickname\n  FROM audit_logs a\n  LEFT JOIN users u ON u.id = a.actor_id\n WHERE ($1::text        IS NULL OR a.target_type = $1)\n   AND ($2::text        IS NULL OR a.target_id   = $2)\n   AND ($3::text        IS NULL OR a.action      = $3)\n   AND ($4::bigint      IS NULL OR a.actor_id    = $4)\n   AND ($5::timestamptz IS NULL OR a.created_at >= $5)\n   AND ($6::timestamptz IS NULL OR a.created_at <  $6)\n   AND ($7::timestamptz IS NULL OR (a.created_at, a.id) < ($7, $8))\n ORDER BY a.created_at DESC, a.id DESC\n LIMIT $9"},
		{"message.listConversationsSQL", "WITH conv AS (\n    SELECT peer, max(id) AS last_id FROM (\n        SELECT high_id AS peer, id FROM messages WHERE low_id  = $1\n        UNION ALL\n        SELECT low_id  AS peer, id FROM messages WHERE high_id = $1\n    ) c1\n     GROUP BY peer\n)\nSELECT l.peer, COALESCE(ux.n, 0) AS unread_count,\n       m.id, m.public_id::text, m.body, m.sender_id, m.read_at, m.created_at,\n       u.username, u.nickname, u.avatar_hash, u.avatar_small_hash\n  FROM conv l\n  JOIN users    u ON u.id = l.peer AND u.status <> 'deleted'\n  JOIN messages m ON m.id = l.last_id\n  LEFT JOIN (\n      SELECT sender_id AS peer, count(*) AS n FROM messages\n       WHERE low_id = $1 AND read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id\n       GROUP BY sender_id\n      UNION ALL\n      SELECT sender_id AS peer, count(*) AS n FROM messages\n       WHERE high_id = $1 AND read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id\n       GROUP BY sender_id\n  ) ux ON ux.peer = l.peer\n WHERE ($2::bigint = 0 OR l.last_id < $2)\n ORDER BY m.id DESC\n LIMIT $3"},
		{"media.gcCandidates", "SELECT i.hash FROM images i\n WHERE i.refcount = 0\n   AND i.updated_at < now() - interval '1 hour'\n   AND NOT EXISTS (SELECT 1 FROM default_avatars d WHERE d.hash = i.hash)\n ORDER BY i.updated_at\n LIMIT $1"},
	}
	var out []string
	for _, c := range sqlCases {
		conn, cerr := pool.Acquire(ctx)
		if cerr != nil { t.Fatal(cerr) }
		_, perr := conn.Conn().Prepare(ctx, "probe_stmt", c.sql)
		conn.Release()
		if perr != nil {
			out = append(out, "SQL_FAIL\t"+c.name+"\t"+oneLine(perr.Error()))
		} else {
			out = append(out, "SQL_OK\t"+c.name+"\t-")
		}
	}
	sort.Strings(out)
	summary := "BUSINESS_SQL_PROBE\n" + strings.Join(out, "\n") + "\n"
	if p := os.Getenv("PROBE_SQL_OUT"); p != "" { _ = os.WriteFile(p, []byte(summary), 0o644) }
	t.Log("\n" + summary)
}
