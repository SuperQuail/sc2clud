package media_test

import (
	"image/color"
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/media"
)

// L1（拍板第二轮）：**收款码是给人扫的图** —— 扫码付款不需要账号，所以陌生人（登录的无关用户）
// 与游客都必须真拿到它，不能是占位图。
//
// 旧口径（d5 §3.3）把收款码的引用行写死成 private，canView 只放行「所有者 / 超管 / 持 reward.verify」：
// `GET /users/{handle}/channels` 照样回 `/img/<hash>`，可那个 hash 对访客渲染成占位图 ——
// 打赏面板上永远扫不出码（K-FE 报的 L1 功能缺口）。media_test.go 的 TestFetchImageVisibility
// 原先看着像把这条行为钉住了，但它量的是**帖子草稿图**那一档（private = 未过审主题的配图），
// 所以那两格「无关登录用户 / 游客 → false」在新口径下**仍然是对的**，收款码由本文件量。
//
// 新口径：引用行写 public。**要不要对外展示这个码**由作者侧的 show_channels 开关管
// （reward 域的列表闸，关着就回空数组），不是把图本身锁上。
func TestPaymentChannelImageIsFetchableByStrangers(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	bob := h.newUser("bob")
	out, err := h.svc.AddPaymentChannel(h.ctx, h.actor(alice), media.AddPaymentChannelInput{
		Body: pngBytes(t, 6, 6, color.RGBA{R: 9, A: 255}),
	})
	if err != nil {
		t.Fatalf("加收款码: %v", err)
	}
	hash := strings.TrimPrefix(out.Image, "/img/")
	if hash == out.Image {
		t.Fatalf("收款码必须给 /img/<hash> 形状的地址，实际 %q", out.Image)
	}

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
			t.Fatalf("%s: 取收款码不许报错（会变成裂图），实际 %v", c.name, err)
		}
		if got.Placeholder != nil || !got.Cache || got.Path == "" || got.Mime != "image/png" {
			t.Fatalf("%s 必须真拿到收款码图（打赏面板要能扫），实际 %+v", c.name, got)
		}
	}
}
