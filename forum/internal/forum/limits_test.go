package forum

import "testing"

// 上限是**按字符**卡的，不是按字节。
//
// 这条不是形式主义：一个汉字 3 字节，按字节卡会把中文用户的上限砍到三分之一 ——
// 项目里已经栽过一次同类的账（昵称校验一边按 rune、一边按字节，7 个汉字就 500）。
func TestContentLimitsArePerRuneNotPerByte(t *testing.T) {
	// 帖子：正好 20000 个汉字要过，20001 个要让路
	if err := checkContentLen(rep("字", MaxTopicContent), MaxTopicContent, "content_md"); err != nil {
		t.Fatalf("正好上限不该被拒: %v", err)
	}
	if err := checkContentLen(rep("字", MaxTopicContent+1), MaxTopicContent, "content_md"); err == nil {
		t.Fatal("超一个字就该拒")
	}
	// 回复：8000 / 8001
	if err := checkContentLen(rep("喵", MaxPostContent), MaxPostContent, "content_md"); err != nil {
		t.Fatalf("回复正好上限不该被拒: %v", err)
	}
	if err := checkContentLen(rep("喵", MaxPostContent+1), MaxPostContent, "content_md"); err == nil {
		t.Fatal("回复超一个字就该拒")
	}
	// 反过来钉一句：字节数已经远超上限，但字符数没超 —— 必须放行。
	// （20000 个汉字 = 60000 字节；按字节卡的话这一条会红。）
	long := rep("字", MaxTopicContent)
	if len([]byte(long)) <= MaxTopicContent {
		t.Fatal("这条用例的前提是字节数 > 上限，夹具先不成立")
	}
	if err := checkContentLen(long, MaxTopicContent, "content_md"); err != nil {
		t.Fatalf("按字节卡了才会红: %v", err)
	}
}

func rep(s string, n int) string {
	out := make([]rune, n)
	for i := range out {
		out[i] = []rune(s)[0]
	}
	return string(out)
}
