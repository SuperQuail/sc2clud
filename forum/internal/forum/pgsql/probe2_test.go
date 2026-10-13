package pgsql

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestProbeInsertIssue(t *testing.T) {
	ctx, pool, client, _, userID, _ := voteFixture(t)
	var boardID, topicID int64
	if err := pool.QueryRow(ctx, "SELECT id FROM boards LIMIT 1").Scan(&boardID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT id FROM topics LIMIT 1").Scan(&topicID); err != nil {
		t.Fatal(err)
	}
	_ = boardID
	store := NewStore(client)
	_ = store
	id, number, err := InsertIssue(ctx, client, uuid.NewString(), topicID, userID, "bug", "标题", "md", "<p>md</p>", "md", "", time.Now().UTC())
	t.Logf("InsertIssue id=%d number=%d err=%v", id, number, err)

	// 同一形状的 source 插入（它现在能过），用来对照
	sid, serr := InsertSource(ctx, client, uuid.NewString(), topicID, SourceInput{Provider: "baidu", URL: "https://x.com"}, time.Now().UTC())
	t.Logf("InsertSource id=%d err=%v", sid, serr)
}
