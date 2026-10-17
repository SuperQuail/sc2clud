package app

import (
	"context"
	"errors"
	"testing"

	"forum/internal/platform/queue"
)

// AI 放行后必须补一条 search:index。
//
// 理由：indexTopic（tasks.go）对「未过审」的主题是把索引行**删掉**，而 search:index 只由
// 发帖 / 改帖 / 删帖入队。人工放行自己补了一条（forum/review_queue.go 的 344 行），
// AI 判定跑在 pgx.Tx 里、够不到 ent 事务，补不了 —— 只能由 reviewTopic 这个事务外落点补。
// 少了它，AI 放行的帖在搜索里**永远**不存在（直到下一次编辑 / 删除把它重新入队）。
//
// 这条用例不需要真库：把「判定」与「入队」两个动作抽成注入参数，就能钉住「放行之后有没有补」。
func TestReviewTopicEnqueuesSearchIndexAfterApproval(t *testing.T) {
	for _, tc := range []struct {
		name      string
		trigger   string
		reviewErr error
		wantTask  bool
	}{
		{"新帖 create 放行", "create", nil, true},
		{"编辑稿 edit 放行", "edit", nil, true},
		{"判定失败（队列要重试）不补索引", "create", errors.New("ai: 上游 5xx"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []queue.Task
			var gotTrigger string
			review := func(_ context.Context, id int64, trigger string) error {
				if id != 42 {
					t.Fatalf("审核的主题 id = %d，想要 42", id)
				}
				gotTrigger = trigger
				return tc.reviewErr
			}
			enqueue := func(_ context.Context, task queue.Task) error {
				got = append(got, task)
				return nil
			}

			err := reviewThenIndex(context.Background(), review, enqueue, 42, tc.trigger)
			if tc.reviewErr != nil {
				if !errors.Is(err, tc.reviewErr) {
					t.Fatalf("判定失败要原样报出去（队列据此退避重试），实际 %v", err)
				}
			} else if err != nil {
				t.Fatalf("reviewThenIndex: %v", err)
			}
			if gotTrigger != tc.trigger {
				t.Fatalf("trigger 没原样交给 AI 判定：得到 %q，想要 %q", gotTrigger, tc.trigger)
			}
			if !tc.wantTask {
				if len(got) != 0 {
					t.Fatalf("判定失败不该补索引，实际入队 %d 条", len(got))
				}
				return
			}
			if len(got) != 1 {
				t.Fatalf("放行后该补 1 条任务，实际 %d 条", len(got))
			}
			task := got[0]
			if task.Type != queue.TypeSearchIndex {
				t.Fatalf("任务类型 = %q，想要 %q", task.Type, queue.TypeSearchIndex)
			}
			// 同 key 去重：人工那条路 / 重复判定多排一次也只是幂等重建（indexTopic 本身幂等）。
			if want := "topic:42"; task.UniqueKey != want {
				t.Fatalf("UniqueKey = %q，想要 %q", task.UniqueKey, want)
			}
			p, ok := task.Payload.(map[string]int64)
			if !ok || p["id"] != 42 {
				t.Fatalf("payload = %#v，想要 map[id:42]（indexTopic 只认这个形状）", task.Payload)
			}
		})
	}
}
