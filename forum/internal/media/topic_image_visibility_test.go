package media_test

import (
	"image/color"
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/media"
)

// 图文帖（拍板第三轮「图文帖需要整个做完」）：配图的档位**跟着主题的审核态走**。
//
// 现状（K2-A 记的两条口径缺口）：AttachTopicImage 的引用行写 `VisibilityPrivate`，
// 而全仓**没有一处**把配图翻档 —— 于是帖子过审之后，正文里的图对作者以外的人（含游客）
// 仍然是一张占位图（列表页的封面同样取不到）。前端拿到的是 200 + 占位图，不是裂图，
// 所以只看接口状态码永远发现不了（交接单 §5.2 那个病）。
//
// 新口径：**未过审不许外泄、过审后可见**，判定在**读路径**上做（同一张图不用重传）：
//   - 主题不是「visibility='normal' AND review_state='approved'」→ 只有作者本人 / 超管拿得到；
//   - 主题过审 → 所有人都拿得到（正文里的 <img> 与列表封面才算真的出来）。
func TestTopicImageFollowsTopicReviewState(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	bob := h.newUser("bob")
	topicID, _ := h.newTopic(alice, "normal")
	// 新帖默认是待审（0004 的 DEFAULT 'pending'）——这一条就是「未过审不许外泄」的那一格。
	h.mustExec("UPDATE topics SET review_state = 'pending' WHERE public_id = $1", topicID)

	out, err := h.svc.AttachTopicImage(h.ctx, h.actor(alice, authz.PermTopicCreate), media.AttachTopicImageInput{
		TopicPublicID: topicID,
		Body:          pngBytes(t, 7, 7, color.RGBA{G: 120, A: 255}),
	})
	if err != nil {
		t.Fatalf("贴配图: %v", err)
	}
	hash := strings.TrimPrefix(out.URL, "/img/")

	// ① 待审期间：作者拿得到（他自己要能预览），陌生人拿不到。
	if got, err := h.svc.FetchImage(h.ctx, h.actor(alice), hash); err != nil || got.Placeholder != nil {
		t.Fatalf("待审期间作者本人必须拿得到自己的配图，实际 %+v / %v", got, err)
	}
	for _, c := range []struct {
		name  string
		actor *authz.Actor
	}{
		{"无关登录用户", h.actor(bob)},
		{"游客", nil},
	} {
		got, err := h.svc.FetchImage(h.ctx, c.actor, hash)
		if err != nil {
			t.Fatalf("%s: 取图不许报错（会变成裂图），实际 %v", c.name, err)
		}
		if got.Placeholder == nil {
			t.Fatalf("%s 在主题**未过审**时不该拿到配图（未过审内容不许外泄），实际 %+v", c.name, got)
		}
	}

	// ② 过审之后：同一张图（没有重传）对所有人可见 —— 正文里的图与列表封面这时才真的出来。
	h.mustExec("UPDATE topics SET review_state = 'approved' WHERE public_id = $1", topicID)
	for _, c := range []struct {
		name  string
		actor *authz.Actor
	}{
		{"无关登录用户", h.actor(bob)},
		{"游客", nil},
		{"所有者", h.actor(alice)},
		{"超管", &authz.Actor{UserID: bob.ID, Status: "active", Activated: true, IsSuper: true}},
	} {
		got, err := h.svc.FetchImage(h.ctx, c.actor, hash)
		if err != nil {
			t.Fatalf("%s: 取配图不许报错，实际 %v", c.name, err)
		}
		if got.Placeholder != nil || !got.Cache || got.Path == "" || got.Mime != "image/png" {
			t.Fatalf("%s 在主题过审后必须真拿到配图，实际 %+v", c.name, got)
		}
	}

	// ③ 主题被删（visibility='deleted'）→ 又收回去（读者本来也进不去那个帖子）。
	h.mustExec("UPDATE topics SET visibility = 'deleted' WHERE public_id = $1", topicID)
	if got, err := h.svc.FetchImage(h.ctx, nil, hash); err != nil || got.Placeholder == nil {
		t.Fatalf("主题被删后游客不该再拿到配图，实际 %+v / %v", got, err)
	}
}

// 私密档的**其他**来源不受影响：主题过审了也不该把「不是配图的私有图」放出去。
// （这张图没有被 topic_images 引用，所以上面那条按主题放行的规则不该管到它。）
func TestPrivateImageWithoutTopicStaysPrivate(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	bob := h.newUser("bob")
	if err := h.putImage(h.actor(alice), pngBytes(t, 5, 5, color.RGBA{R: 255, A: 255}), media.VisibilityPrivate); err != nil {
		t.Fatalf("放一张私有图: %v", err)
	}
	hash := h.text("SELECT hash FROM images LIMIT 1")
	if got, err := h.svc.FetchImage(h.ctx, h.actor(bob), hash); err != nil || got.Placeholder == nil {
		t.Fatalf("没有被主题引用的私有图对无关用户必须仍是占位图，实际 %+v / %v", got, err)
	}
}
