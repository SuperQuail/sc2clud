package forum

import (
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// E1（拍板 08）：「补全回帖门槛数据」—— 老站两档门槛（发帖 / 回帖），新站原来只有一档。
//
// 两个断言，判据都**只**由「两档分开」满足：
//
//	· 发帖门槛 5 的分区：等级 2 发不了；**同一个分区里回帖放行**（min_reply_level 还是 0）
//	  —— 旧行为下回帖走的是发帖门槛，必然 403；
//	· 回帖门槛 5 的分区：等级 9 的人**发得了**（min_post_level 是 0）、**回不了**，
//	  且文案是「回帖」不是「发帖」。
func TestBoardReplyLevelIsSeparateFromPostLevel(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 2, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	// 发帖门槛 5、回帖门槛 0：这个分区「能聊不能发」。
	h.seedBoardReply("chatty", 5, 0, false)

	_, err := h.svc.CreateTopic(h.ctx, author, CreateTopicInput{BoardSlug: "chatty", Title: "x", ContentMD: "y"})
	assertCode(t, err, "forum.level_too_low")

	// 主题得由**发得动**的人发（等级 9），再由等级 2 的作者去回 —— 这正是公告区的形状：
	// 「只有管理员能发帖，但大家都能回帖」。
	poster, _ := h.author("poster", 9, true, authz.PermTopicCreate)
	d := h.mustTopic(poster, CreateTopicInput{BoardSlug: "chatty", Title: "公告", ContentMD: "y"})
	if _, err := h.svc.CreatePost(h.ctx, author, d.ID, CreatePostInput{ContentMD: "回帖"}); err != nil {
		t.Fatalf("回帖门槛是 0，等级 2 的人应当能回（旧行为下这里必 403）: %v", err)
	}

	// 反过来：发帖门槛 0、回帖门槛 10 → 等级 9 的人发得动、回不动，且说的是「回帖」。
	h.seedBoardReply("strict", 0, 10, false)
	d2 := h.mustTopic(poster, CreateTopicInput{BoardSlug: "strict", Title: "只读讨论", ContentMD: "y"})
	_, err = h.svc.CreatePost(h.ctx, poster, d2.ID, CreatePostInput{ContentMD: "回帖"})
	assertCode(t, err, "forum.level_too_low")
	if ae, ok := err.(*apperr.Error); !ok || !strings.Contains(ae.Msg, "回帖") {
		t.Fatalf("回帖门槛的拒绝文案应当说「回帖」，实际 %v", err)
	}

	// 改标题不被回帖门槛拦住（门槛只管「新增内容」这一件事）。
	// 换作者自己改：改别人的帖子要 delete.any/版主，与门槛无关，别把两件事混在一条断言里。
	owner, _ := h.author("owner", 9, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	d3 := h.mustTopic(owner, CreateTopicInput{BoardSlug: "strict", Title: "改之前", ContentMD: "y"})
	if err := h.svc.UpdateTopic(h.ctx, owner, d3.ID, UpdateTopicInput{Title: ptrStr("改标题")}); err != nil {
		t.Fatalf("改标题不该被回帖门槛拦住: %v", err)
	}
}

// TestReplyLevelUsesItsOwnCode 钉「回帖门槛」与「ACL 拒绝」是两种 code：
// 前者可以靠升级解决，后者是分区规则。混在一起前端就没法给对提示。
func TestReplyLevelUsesItsOwnCode(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 1, true, authz.PermTopicCreate)
	h.seedBoardReply("strict", 0, 3, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "strict", Title: "x", ContentMD: "y"})
	_, err := h.svc.CreatePost(h.ctx, author, d.ID, CreatePostInput{ContentMD: "回帖"})
	if err == nil {
		t.Fatal("等级 1 < 3，应当被回帖门槛拦住")
	}
	ae, ok := err.(*apperr.Error)
	if !ok {
		t.Fatalf("应当是 *apperr.Error，实际 %T", err)
	}
	if ae.Code != "forum.level_too_low" {
		t.Fatalf("应当是 forum.level_too_low（可用等级解决），实际 %s", ae.Code)
	}
	if v, ok := ae.Fields["level"]; !ok || v != "3" {
		t.Fatalf("带上需要的等级，前端才能提示，实际 %v", ae.Fields)
	}
}
