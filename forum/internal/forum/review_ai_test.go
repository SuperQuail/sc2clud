package forum

import (
	"strings"
	"testing"
)

// 老站就有的两条用例，照搬（它们钉的是最容易错的地方）：
// 三个工具映射三态；认不出的工具名**不能**被当成通过。
func TestThreeToolsMapToThreeVerdicts(t *testing.T) {
	for _, tc := range []struct {
		name string
		want AiVerdict
	}{
		{"approve_post", AiApprove},
		{"pending_comment", AiPending},
		{"reject_post", AiReject},
	} {
		target := "post"
		if tc.name == "pending_comment" {
			target = "comment"
		}
		got, ok := AiVerdictFromToolName(tc.name, target)
		if !ok || got != tc.want {
			t.Fatalf("%s -> %v,%v 期望 %v", tc.name, got, ok, tc.want)
		}
	}
	if _, ok := AiVerdictFromToolName("delete_everything", "post"); ok {
		t.Fatal("认不出的工具名必须判为「不是有效判定」")
	}
	if AiPending.ReviewState() != "pending" || AiApprove.ReviewState() != "approved" || AiReject.ReviewState() != "rejected" {
		t.Fatal("三态到 review_state 的映射错了")
	}
}

func TestAiToolsAreOpenAIShaped(t *testing.T) {
	list := AiTools("post")
	if len(list) != 3 {
		t.Fatalf("应当是通过/待定/不通过三个工具，实际 %d", len(list))
	}
	for _, tool := range list {
		if tool.Type != "function" || tool.Function.Description == "" {
			t.Fatalf("工具形状不对: %+v", tool)
		}
		if tool.Function.Parameters["type"] != "object" {
			t.Fatalf("parameters 必须是 object: %+v", tool.Function.Parameters)
		}
	}
}

func TestPostReviewTextMatchesOldShape(t *testing.T) {
	got := PostReviewText("标题", "原版战役 mod", "正文", "唐天", []string{"网盘 https://x"})
	for _, want := range []string{"【帖子】", "标题：标题", "分区：原版战役 mod", "作者：唐天", "下载来源：", "- 网盘 https://x"} {
		if !strings.Contains(got, want) {
			t.Fatalf("缺少 %q:\n%s", want, got)
		}
	}
}
