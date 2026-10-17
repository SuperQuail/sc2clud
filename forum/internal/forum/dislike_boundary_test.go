package forum

import (
	"encoding/json"
	"fmt"
	"testing"

	"forum/internal/authz"
)

// J3（拍板 08）：契约保持**单值投票**；**点踩数据只对「管理员及以上权限」与「内容发布者」下发**。
//
// 用户原话：「单值,并且界面只显示点赞,不显示点踩,只有管理员以上权限/发布者能看到点踩数据」。
// 这是**信任边界**：后端按身份决定下不下发，而不是前端藏一个字段。
//
// 判据是**序列化之后的 JSON 里有没有那个键**（omitempty），不是 Go 结构体里的值 ——
// 「结构体里有、发出去没有」正是要的行为，而只断言值等于 0 分不清
// 「藏起来了」与「真的是 0」（本仓库的高频事故形态）。
func TestDislikeCountOnlyReachesAdminsAndAuthors(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	// 造一条真有踩的楼层：5 个人踩
	post, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "有争议的回复"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		disliker, _ := h.author(fmt.Sprintf("hater%d", i), 1, true, "")
		if _, err := h.svc.Vote(h.ctx, disliker, VotePost, post.ID, -1); err != nil {
			t.Fatalf("点踩失败: %v", err)
		}
	}

	// ① 游客：JSON 里**没有** dislike_count 这个键，like_count 照旧
	listJSON := postsJSON(t, h, nil, topic.ID, "guest")
	for _, item := range listJSON {
		if _, ok := item["dislike_count"]; ok {
			t.Fatalf("游客不该拿到点踩数据（信任边界在后端）: %v", item)
		}
		if _, ok := item["like_count"]; !ok {
			t.Fatalf("点赞数照旧要下发: %v", item)
		}
	}

	// ② 普通登录用户（不是作者、没有管理员权限）：同样拿不到
	stranger, _ := h.author("stranger", 3, true, authz.PermTopicCreate)
	row := findPost(t, postsJSON(t, h, stranger, topic.ID, "stranger"), post.ID)
	if _, ok := row["dislike_count"]; ok {
		t.Fatalf("普通用户不该拿到点踩数据: %v", row)
	}

	// ③ 管理员及以上（topic.delete.any）：能拿到，而且是**真的数**
	admin, _ := h.author("mod", 9, true, authz.PermTopicDeleteAny)
	adminRow := findPost(t, postsJSON(t, h, admin, topic.ID, "admin"), post.ID)
	v, ok := adminRow["dislike_count"]
	if !ok {
		t.Fatalf("管理员及以上必须能拿到点踩数据: %v", adminRow)
	}
	if n, _ := v.(float64); int(n) != 5 {
		t.Fatalf("管理员看到的踩数应为 5，实际 %v", v)
	}

	// ④ 发布者（这条楼层是他的）：也能拿到 —— 作者得知道自己的内容被踩了多少。
	// 注意 author 没有 topic.delete.any，所以这一条**只可能**由「归属」那一半满足。
	authorRow := findPost(t, postsJSON(t, h, author, topic.ID, "author"), post.ID)
	if _, ok := authorRow["dislike_count"]; !ok {
		t.Fatalf("内容发布者必须能拿到自己内容上的点踩数据: %v", authorRow)
	}

	// ⑤ 投票响应同一个边界：单值投票（my_vote ∈ {-1,0,1}），踩数只对能看的人出现
	strangerVote, err := h.svc.Vote(h.ctx, stranger, VotePost, post.ID, -1)
	if err != nil {
		t.Fatal(err)
	}
	if strangerVote.MyVote != -1 {
		t.Fatalf("契约是单值投票：my_vote 只有 -1/0/1，实际 %d", strangerVote.MyVote)
	}
	if b, _ := json.Marshal(strangerVote); jsonHasKey(t, b, "dislike_count") {
		t.Fatalf("普通用户的投票响应不该带踩数: %s", b)
	}
	adminVote, err := h.svc.Vote(h.ctx, admin, VotePost, post.ID, -1)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := json.Marshal(adminVote); !jsonHasKey(t, b, "dislike_count") {
		t.Fatalf("管理员及以上必须能拿到踩数: %s", b)
	}
}

// postsJSON 按身份取一页回复并解成 JSON 数组（**序列化之后**的形状才是判据）。
func postsJSON(t *testing.T, h *harness, who *authz.Actor, topicID, label string) []map[string]any {
	t.Helper()
	page, err := h.svc.ListPosts(h.ctx, who, ListPostsInput{TopicPublicID: topicID})
	if err != nil {
		t.Fatalf("%s 读回复失败: %v", label, err)
	}
	if len(page.Items) == 0 {
		t.Fatalf("%s 应当看得到回复", label)
	}
	b, err := json.Marshal(page.Items)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// findPost 在一页回复里按 public_id 找一行：列表里可能还有别的楼层，
// 只断言第 0 条会让「是哪一条」变成运气。
func findPost(t *testing.T, items []map[string]any, publicID string) map[string]any {
	t.Helper()
	for _, item := range items {
		if id, _ := item["id"].(string); id == publicID {
			return item
		}
	}
	t.Fatalf("列表里找不到楼层 %s", publicID)
	return nil
}

func jsonHasKey(t *testing.T, b []byte, key string) bool {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	_, ok := m[key]
	return ok
}
