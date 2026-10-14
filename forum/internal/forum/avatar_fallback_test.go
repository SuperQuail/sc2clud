package forum

import (
	"strings"
	"testing"

	"forum/internal/authz"
)

// seedImage 落一张图：images 是 users 三根头像列的 FK 目标，哈希要过 ck_images_hash_fmt。
func (h *harness) seedImage(hash string) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx, "INSERT INTO images (hash, size, mime) VALUES ($1, 1, 'image/webp')", hash); err != nil {
		h.t.Fatal(err)
	}
}

// setUserAvatar 写头像两列 + 默认头像；空串表示「没设过」（落库是 NULL）。
func (h *harness) setUserAvatar(id int64, avatar, def string) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx, `
UPDATE users SET avatar_hash = NULLIF($2, ''), avatar_small_hash = NULL, default_avatar_hash = NULLIF($3, '')
WHERE id = $1`, id, avatar, def); err != nil {
		h.t.Fatal(err)
	}
}

// 作者头像：avatar_hash 为空时回落到 default_avatar_hash。
// 来历：dev 实测 GET /api/v1/topics?limit=1 的 author.avatar_hash 是空串（用户 Alenger），
// 于是列表 / 帖子页 / 评论区的作者头像全只剩首字母占位 —— 老站是有站点级默认头像的。
// 回落写在 pgsql 每条作者 SQL 的 COALESCE 里，这一条盯的是 DTO 真的拿到了回落后的哈希。
func TestAuthorAvatarFallsBackToDefault(t *testing.T) {
	h := newHarness(t)
	author, uid := h.author("alice", 1, true, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Kind: "discussion", Title: "头像", ContentMD: "x"})

	def := strings.Repeat("a", 64)
	h.seedImage(def)
	h.setUserAvatar(uid, "", def)

	page, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("应有 1 条，实际 %d", len(page.Items))
	}
	if got := page.Items[0].Author.AvatarHash; got != def {
		t.Fatalf("列表作者头像应回落到默认头像 %s，实际 %q", def, got)
	}

	detail, err := h.svc.TopicDetail(h.ctx, nil, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := detail.Author.AvatarHash; got != def {
		t.Fatalf("帖子页作者头像应回落到默认头像 %s，实际 %q", def, got)
	}
	if got := detail.Author.AvatarSmall; got != def {
		t.Fatalf("没有小图时小头像跟主头像（media.Avatar 的口径），实际 %q", got)
	}

	// 自己设过头像就以它为准：默认头像只是兜底，不能盖掉本人的那张。
	own := strings.Repeat("b", 64)
	h.seedImage(own)
	h.setUserAvatar(uid, own, def)
	detail, err = h.svc.TopicDetail(h.ctx, nil, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := detail.Author.AvatarHash; got != own {
		t.Fatalf("设过头像应优先，实际 %q", got)
	}
	if got := detail.Author.AvatarSmall; got != own {
		t.Fatalf("avatar_small_hash 空时应跟本人头像，而不是默认头像，实际 %q", got)
	}
}
