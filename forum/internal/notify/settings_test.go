package notify

import (
	"testing"

	"forum/internal/notify/pgsql"
	"forum/internal/platform/clock"
)

// settings_test.go 覆盖 GET/PUT /notifications/settings 背后的两个服务方法。
// **接真库**（newDB 跑的是 migrations/postgres 的原样迁移）：默认值在另一侧
// （0018 的列默认值），只有连库才验得到「没设置过时回什么」。

func TestSettingsDefaultAndRoundTrip(t *testing.T) {
	ctx, client, pool := newDB(t)
	uid := newUser(t, ctx, pool, "settingsuser")
	// 用真实实现（不是 defaultSettings 替身）：这两个方法读写的就是 user_notice_settings
	svc := NewService(client, clock.Real{}, pgsql.New(client), NewNoticeSettings(pgsql.New(client)))
	a := actor(uid)

	got, err := svc.Settings(ctx, a)
	if err != nil {
		t.Fatalf("读默认设置失败: %v", err)
	}
	if !got.Alert || got.ReplyScope != "all" || got.MentionScope != "all" || !got.LikeAlert {
		t.Fatalf("没设置过时必须回列默认值，实际 %+v", got)
	}

	saved, err := svc.UpdateSettings(ctx, a, NoticeSetting{Alert: false, ReplyScope: "none", MentionScope: "all", LikeAlert: false})
	if err != nil {
		t.Fatalf("保存设置失败: %v", err)
	}
	if saved.Alert || saved.ReplyScope != "none" || saved.MentionScope != "all" || saved.LikeAlert {
		t.Fatalf("回执与写入的值不一致: %+v", saved)
	}

	// 再读一次：回执可能是内存里那份，这里排掉「写没落库」
	again, err := svc.Settings(ctx, a)
	if err != nil {
		t.Fatalf("重读设置失败: %v", err)
	}
	if *again != *saved {
		t.Fatalf("重读与回执不一致: %+v vs %+v", again, saved)
	}

	// 重复保存是 upsert：一行一人，不能插出第二行
	if _, err := svc.UpdateSettings(ctx, a, NoticeSetting{Alert: true, ReplyScope: "all", MentionScope: "none", LikeAlert: true}); err != nil {
		t.Fatalf("第二次保存失败: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_notice_settings WHERE user_id = $1`, uid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("一人只能有一行设置，实际 %d 行", n)
	}
}

// 多值 kind（2026-10-14）：W1 的信息中心要把「系统通知」做成 system+review+sanction+reward
// 四类合一（DevRoom 10-messages 的设计）。单值做不到 —— 前端只能拆四次请求，
// 而每条请求各有游标，翻页会互相错位。
func TestListNotificationsMultiKind(t *testing.T) {
	ctx, client, pool := newDB(t)
	u := newUser(t, ctx, pool, "multikind")
	svc := NewService(client, clock.Real{}, pgsql.New(client), NewNoticeSettings(pgsql.New(client)))

	for i, k := range []string{KindReply, KindSystem, KindReview, KindSanction} {
		tx, err := client.Tx(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.Create(ctx, tx, CreateInput{UserID: u, Kind: k, RefType: RefPost, RefID: int64(i + 1)}); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}

	// 单值照旧
	res, err := svc.List(ctx, actor(u), ListInput{Kind: KindReply})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 {
		t.Fatalf("单值 kind 应当回 1 条，实际 %d", len(res.Items))
	}

	// 多值 = 信息中心「系统通知」那一档
	res, err = svc.List(ctx, actor(u), ListInput{Kind: KindSystem + "," + KindReview + "," + KindSanction})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 3 {
		t.Fatalf("多值 kind 应当回 3 条，实际 %d", len(res.Items))
	}

	// 未知值必须 400：静默返回空列表会让「没有这类通知」与「你打错了」长得一样
	if _, err := svc.List(ctx, actor(u), ListInput{Kind: "bogus"}); err == nil {
		t.Fatal("未知 kind 必须被拒")
	}
}

// 值域由 CHECK 约束与 service 两层把守，这里钉住 service 那一层会红。
// 'followed' 是 0018 按拍板 §8.3 明确删掉的值（本产品没有关注用户）——
// 所以 DevRoom 10-messages 里那个三选项的「回复我的消息提醒」多了一个假选项（已记进缺陷清单）。
func TestUpdateSettingsRejectsUnknownScope(t *testing.T) {
	ctx, client, pool := newDB(t)
	uid := newUser(t, ctx, pool, "settingsscope")
	svc := NewService(client, clock.Real{}, pgsql.New(client), NewNoticeSettings(pgsql.New(client)))

	if _, err := svc.UpdateSettings(ctx, actor(uid), NoticeSetting{Alert: true, ReplyScope: "followed", MentionScope: "all", LikeAlert: true}); err == nil {
		t.Fatal("reply_scope='followed' 必须被拒绝（本产品没有关注用户）")
	}
	if _, err := svc.UpdateSettings(ctx, actor(uid), NoticeSetting{Alert: true, ReplyScope: "all", MentionScope: "everyone", LikeAlert: true}); err == nil {
		t.Fatal("mention_scope='everyone' 必须被拒绝")
	}
}
