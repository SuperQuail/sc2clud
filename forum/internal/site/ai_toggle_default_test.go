package site_test

// D63(a) 的红钉：ai.review.enabled 在 site_settings 里**缺行**时的生效值。
//
// 事实：settings.go 的声明默认值曾经写成 off，而「缺行回落声明默认」是这张表的承诺（不在迁移里插
// 默认行）。于是一张没配置过这个键的库 —— 新装的、以及 dev / prod —— AI 审核默认**死**着：
// 发帖照常入队 ai:review、worker 照常消费，但 aireview.ReviewTopic 在第 1 步就被
// "|| !SettingBool(ai.review.enabled)" 短路，一个外呼都不发，主题静默留在人工队列。
// 对外的现象就是「新帖子不会自动送 AI 审核」。
//
// 设计稿写的是 true（完全重构/后端设计/d7-ai-review.md §2.2：默认 true）。这条用例钉住
// 「声明默认 = on」与「缺行 = 开」两面：只钉代码常量，Setting 的回落改了也捉不到；只钉回落，
// 声明面上的漂移看不出根因。两面都在，谁漂谁红。

import (
	"testing"

	"forum/internal/site"
)

// 声明默认本身就要是 on（d7 §2.2）：SettingSpecs 是这张表里键的唯一真源。
func TestAiReviewToggleDeclaresOnByDefault(t *testing.T) {
	for _, spec := range site.SettingSpecs() {
		if spec.Key == "ai.review.enabled" && spec.Default != "on" {
			t.Fatalf("ai.review.enabled 的声明默认值是 %q，设计稿 d7 §2.2 默认 true（缺行即失效：全站默认 AI 审核不开）", spec.Default)
		}
	}
}

func TestAiReviewToggleMissingRowMeansOn(t *testing.T) {
	h := newHarness(t)
	// 库是干净的（harness 不预插 site_settings）：读到的就是声明默认。
	if !h.svc.SettingBool(h.ctx, "ai.review.enabled") {
		t.Fatal("ai.review.enabled 缺行应当按声明的默认值走（on），实际却是 off —— AI 审核默认死着，这正是 D63(a) 的根因")
	}
}
