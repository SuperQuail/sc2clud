package pgsql

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	ent "forum/internal/ent"
	"forum/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestMain(m *testing.M) {
	if err := os.Setenv("TZ", "UTC"); err != nil {
		panic(err)
	}
	testsupport.Main(m)
}

func setup(t *testing.T) (context.Context, *pgxpool.Pool, *ent.Client) {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".up.sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	for _, name := range files {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(b)); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })
	return ctx, pool, client
}

// voteFixture 造出「一个用户 + 一个分区 + 一个主题 + 一条回复」。
func voteFixture(t *testing.T) (context.Context, *pgxpool.Pool, *ent.Client, string, int64, int64) {
	t.Helper()
	ctx, pool, client := setup(t)
	var roleID, userID, boardID, topicID, postID int64
	if err := pool.QueryRow(ctx, "INSERT INTO roles (key, name) VALUES ('user', 'user') ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name RETURNING id").Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "INSERT INTO users (public_id, username, email, password_hash, nickname, role_id) VALUES ($1,'u','u@e.com','x','u',$2) RETURNING id", uuid.NewString(), roleID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "INSERT INTO boards (slug, name) VALUES ('b','b') RETURNING id").Scan(&boardID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "INSERT INTO topics (public_id, board_id, author_id, title) VALUES ($1,$2,$3,'t') RETURNING id", uuid.NewString(), boardID, userID).Scan(&topicID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "INSERT INTO posts (public_id, topic_id, author_id, floor, content_md, content_html) VALUES ($1,$2,$3,1,'m','m') RETURNING id", uuid.NewString(), topicID, userID).Scan(&postID); err != nil {
		t.Fatal(err)
	}
	_ = client
	return ctx, pool, client, uuid.NewString(), userID, postID
}

// 投票是本域唯一一条会自己拼表名的语句，先把它的原始错误打出来。
func TestVoteDirect(t *testing.T) {
	ctx, pool, client, _, userID, postID := voteFixture(t)
	store := NewStore(client)
	now := time.Now().UTC()

	changed, err := Vote(ctx, client, "post", postID, userID, 1, now)
	t.Logf("Vote(1) changed=%v err=%v", changed, err)
	if err != nil {
		t.Fatalf("Vote: %v", err)
	}
	changed, err = Vote(ctx, client, "post", postID, userID, 1, now)
	t.Logf("Vote(1) again changed=%v err=%v", changed, err)
	changed, err = Vote(ctx, client, "post", postID, userID, -1, now)
	t.Logf("Vote(-1) changed=%v err=%v", changed, err)
	like, dislike, err := store.VoteCounts(ctx, client, "post", postID)
	t.Logf("counts like=%d dislike=%d err=%v", like, dislike, err)
	like, dislike, err = store.Unvote(ctx, client, "post", postID, userID)
	t.Logf("unvote like=%d dislike=%d err=%v", like, dislike, err)
	_ = pool
}
