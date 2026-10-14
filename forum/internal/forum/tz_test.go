package forum

import (
	"testing"
	"time"
)

// E2 / D7：分区列表的「今日」不能写死 UTC+8（老实现是 now().UTC().Add(8*time.Hour)）。
// 这一条盯的是「配置了时区但代码不认」：站点时区换成 UTC-11 之后，
// 昨天 21:00Z 那条主题不该再算进今天。
//
// 时区取 UTC-11 而不是 +12：老实现写死 +8，取 -11 时两种算法的窗口**不相交**，
// 于是断言在旧代码下必红（+12 只让边界挪 4 小时，很容易两边都算「今天」）。
func TestListBoardsTodayUsesConfiguredTimezone(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	uid := h.seedUser("tzuser", role, 1, true)
	board := h.seedBoard("tz-board", 0, false)

	// 固定时钟：2026-10-13 12:00Z。UTC-11 的「今日零点」= 2026-10-13 11:00Z。
	h.clk.T = time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	if _, err := h.pool.Exec(h.ctx, `
INSERT INTO topics (public_id, board_id, author_id, title, created_at, updated_at, last_reply_at)
VALUES (gen_random_uuid(), $1, $2, '昨天 21:00Z', '2026-10-12 21:00:00+00', '2026-10-12 21:00:00+00', '2026-10-12 21:00:00+00')`,
		board, uid); err != nil {
		t.Fatal(err)
	}

	todayOf := func(loc *time.Location) int64 {
		t.Helper()
		svc := NewService(h.ent, h.clk, h.count, h.queue, Deps{
			Users: h.deps, Render: markdownish{}, Queue: h.queue, Counter: h.count, TZ: loc,
		})
		boards, err := svc.ListBoards(h.ctx, nil)
		if err != nil {
			t.Fatalf("ListBoards: %v", err)
		}
		for _, b := range boards {
			if b.Slug == "tz-board" {
				return b.TodayCount
			}
		}
		t.Fatal("没找到 tz-board")
		return -1
	}

	// ① 配置 UTC-11：21:00Z 是**昨天**（它的今日零点在 11:00Z），不该算进来。
	minus11, err := time.LoadLocation("Pacific/Midway") // UTC-11，无夏令时
	if err != nil {
		t.Fatalf("测试环境缺 IANA 时区库: %v", err)
	}
	if got := todayOf(minus11); got != 0 {
		t.Fatalf("UTC-11 站点：昨天 21:00Z 应算昨天（today_count=0），实际 %d —— 时区没跟着配置走", got)
	}

	// ② 兜底仍是 Asia/Shanghai（UTC+8，老行为）：它的今日零点是 2026-10-12 16:00Z，
	//    所以 21:00Z 落在今天。这条钉住「没配置时行为不变」。
	shanghai, err := time.LoadLocation(DefaultSiteTZ)
	if err != nil {
		t.Fatalf("兜底时区名 %q 解析不了: %v", DefaultSiteTZ, err)
	}
	if got := todayOf(shanghai); got != 1 {
		t.Fatalf("兜底 %s：今天 05:00 (+08) 应算今天（today_count=1），实际 %d", DefaultSiteTZ, got)
	}
}
