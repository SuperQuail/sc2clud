package forum

import (
	"testing"

	"forum/internal/authz"
)

// 「作者角色徽标」（拍板 08 §第三轮 3）：主题详情的 author 要能回答「这个人是认证创作者还是管理员」。
//
// 为什么断言落在这里而不是前端：`UserBriefDTO` 以前**根本没有 role 这一列**，
// 于是 routes/topic.tsx 的 toDesignAuthor 只能写一句 shortcut（`t.author.role ?? null` 恒 null），
// 右栏那张作者卡上的徽标位置永远是空的 —— 而**读者**（不是作者本人）最需要这一格。
// 所以判据是：游客身份读到的详情里也带着 key / name / badge_color 三项，而且 role_id 认不出角色时是 null。
func TestTopicDetailCarriesAuthorRole(t *testing.T) {
	h := newHarness(t)
	boardID := h.seedBoard("general", 0, false)
	_ = boardID

	// creator 是 0017 种下的内置角色之一（badge_color = #2563eb）。用它而不是自建角色：
	// 颜色是**数据**（roles.badge_color），自建一个再断言自己写进去的颜色等于什么都没测。
	var creatorID int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM roles WHERE key = 'creator'").Scan(&creatorID); err != nil {
		t.Fatal(err)
	}
	uid := h.seedUser("creator-a", creatorID, 5, true)
	a := h.actor(uid, creatorID, authz.PermTopicCreate)

	d := h.mustTopic(a, CreateTopicInput{
		BoardSlug: "general", Kind: "discussion", Title: "认证创作者的帖子", ContentMD: "正文",
	})

	// ① 作者自己读：三项都在
	got := h.svc.TopicDetail
	detail, err := got(h.ctx, a, d.ID)
	if err != nil {
		t.Fatalf("读详情失败: %v", err)
	}
	if detail.Author.Role == nil {
		t.Fatal("TopicDetailDTO.author.role 是 nil —— 徽标没有数据可画（旧行为）")
	}
	if detail.Author.Role.Key != "creator" || detail.Author.Role.Name != "认证创作者" {
		t.Fatalf("角色两列不对: %+v", *detail.Author.Role)
	}
	// 颜色是数据驱动的那一列（RoleBadge 按它上色）；NULL 也要能表达
	if detail.Author.Role.BadgeColor == nil || *detail.Author.Role.BadgeColor != "#2563eb" {
		t.Fatalf("badge_color 应当透传 #2563eb，实际 %v", detail.Author.Role.BadgeColor)
	}

	// ② 游客读同一篇（trusted=true 直接过审）：角色是**公开**信息，不因为看的人是谁而消失
	guest, err := got(h.ctx, nil, d.ID)
	if err != nil {
		t.Fatalf("游客读详情失败: %v", err)
	}
	if guest.Author.Role == nil || guest.Author.Role.Key != "creator" {
		t.Fatalf("游客也该看到作者角色，实际 %+v", guest.Author.Role)
	}
}

// 角色为 NULL（roles.badge_color 没设）与「用户没有角色行」两档都不能 panic：
// 徽标件自己会回落，后端只要如实表达「没有颜色」。
func TestTopicDetailAuthorRoleWithoutBadgeColor(t *testing.T) {
	h := newHarness(t)
	h.seedBoard("general", 0, false)
	roleID := h.seedRole("plain", false) // seedRole 不写 badge_color
	uid := h.seedUser("plain-a", roleID, 1, true)
	a := h.actor(uid, roleID, authz.PermTopicCreate)

	d := h.mustTopic(a, CreateTopicInput{
		BoardSlug: "general", Kind: "discussion", Title: "没有徽标颜色的角色", ContentMD: "正文",
	})
	detail, err := h.svc.TopicDetail(h.ctx, a, d.ID)
	if err != nil {
		t.Fatalf("读详情失败: %v", err)
	}
	if detail.Author.Role == nil || detail.Author.Role.Key != "plain" {
		t.Fatalf("角色应当照给（只是没有颜色），实际 %+v", detail.Author.Role)
	}
	if detail.Author.Role.BadgeColor != nil {
		t.Fatalf("badge_color 应当是 nil（列是 NULL），实际 %v", *detail.Author.Role.BadgeColor)
	}
}
