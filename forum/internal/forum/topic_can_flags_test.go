package forum

// TopicDetail 的 can_edit / can_reply 钉子（2026-10-15 用户 prod 实测）。
// DTO 的这两个字段从没被赋过值 → 恒 false：所有登录用户都看到「还不能发帖回复」，
// 帖主与超管都没有编辑按钮。语义与写路径同口径（本用例把口径钉住，改语义就会红）：
import (
	"testing"

	"forum/internal/authz"
)

func TestTopicDetailCanFlags(t *testing.T) {
	h := newHarness(t)
	ctx := h.ctx

	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	h.seedBoard("general", 0, false) // acl_enabled=false：登录即可发言（白名单没开）
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "主题", ContentMD: "正文"})

	// 帖主：可回可编
	row, err := h.svc.TopicDetail(ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !row.CanReply {
		t.Fatal("帖主可回")
	}
	if !row.CanEdit {
		t.Fatal("帖主可编自己的帖")
	}

	// 超管（非作者）：canSpeak 第 1 步短路；编辑走 any 档
	role := h.seedRole("superadmin", true)
	uid := h.seedUser("sadmin", role, 9, true)
	super := h.super(uid, role)
	row, err = h.svc.TopicDetail(ctx, super, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !row.CanReply {
		t.Fatal("超管可回（短路）")
	}
	if !row.CanEdit {
		t.Fatal("超管可编别人的帖")
	}

	// 陌生人（无权限点）：off 门下可回，编辑不行
	other, _ := h.author("other", 1, false)
	row, err = h.svc.TopicDetail(ctx, other, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !row.CanReply {
		t.Fatal("白名单没开的分区登录即可回")
	}
	if row.CanEdit {
		t.Fatal("陌生人不可编别人的帖")
	}

	// 锁定后：谁都不能回（CreateReply 的第一道闸就是 locked），编辑不拦
	if err := h.svc.LockTopic(ctx, super, d.ID, true); err != nil {
		t.Fatal(err)
	}
	row, err = h.svc.TopicDetail(ctx, super, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.CanReply {
		t.Fatal("锁定的帖 DTO 也不该说可回")
	}
	if !row.CanEdit {
		t.Fatal("锁定不拦编辑")
	}

	// 游客：两个字段都 false
	row, err = h.svc.TopicDetail(ctx, nil, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.CanReply || row.CanEdit {
		t.Fatal("游客不该拿到任何可行动字段")
	}
}
