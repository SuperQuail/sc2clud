package media_test

import (
	"image/color"
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/media"
)

// L1（拍板第二轮 + 第三轮，**用户第二次强调"不许偏移"**）：收款码**按渠道显示**。
//
// 口径（d5 §3.3 已按本轮拍板改过）：收款码的引用行沿用老站那一档 **登录可见**，
// 但真正的闸是**作者侧的渠道展示开关**（`user_donation_settings.show_channels`）：
//
//	开关开 → 登录用户与游客都真拿得到图（打赏面板要能扫，扫码付款不需要账号）；
//	开关关 → 不是"收起来"，是取不到（渠道列表本来也回空数组，没有合法入口）。
//
// 两件必须一起成立的事：
//  1. **档位不是上传那一刻定死的** —— 同一张码，改一次开关，取图的结果就跟着变（下面第 2 步）；
//  2. **打赏者与游客真能看到** —— 开关开着时 `/img/<hash>` 给的是真图字节，不是占位图。
//
// K2-A 上一轮的做法（上传时写死 public，靠列表闸管）被用户判定为**偏离**（08 第三轮）：
// 它让档位与开关脱钩 —— 开关关着，图仍然对全站可读。本文件是那条口径的替代。
func TestPaymentChannelImageFollowsDisplaySwitch(t *testing.T) {
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

	// 第 1 步：开关**默认关**（0011 迁移的 DEFAULT false，老站也一样）。
	// 这时渠道列表回空数组，图不该对无关的人可读 —— 否则「关掉展示」只关掉了列表，没关掉图。
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
			t.Fatalf("%s 在作者**没开**渠道展示时不该拿到收款码图，实际 %+v", c.name, got)
		}
	}

	// 作者自己永远拿得到（还没开开关时设置页要能预览自己的码）。
	if got, err := h.svc.FetchImage(h.ctx, h.actor(alice), hash); err != nil || got.Placeholder != nil {
		t.Fatalf("作者本人必须拿得到自己的收款码，实际 %+v / %v", got, err)
	}

	// 第 2 步：**上传之后**打开展示开关（设置页那一块）—— 同一个 hash，不需要重传。
	h.mustExec(`INSERT INTO user_donation_settings (user_id, show_channels) VALUES ($1, true)`, alice.ID)

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

	// 第 3 步：把开关关回去 —— 档位跟着回来（这就是「档位能在上传之后调整」的机器证明）。
	h.mustExec(`UPDATE user_donation_settings SET show_channels = false WHERE user_id = $1`, alice.ID)
	if got, err := h.svc.FetchImage(h.ctx, nil, hash); err != nil || got.Placeholder == nil {
		t.Fatalf("关掉展示开关后游客不该再拿到图，实际 %+v / %v", got, err)
	}
}

// 收款码那一档**不是** public：它写的是 VisibilityLogin（老站那一档），
// 「谁能取到」由展示开关在**读路径**上放开。写死 public 就等于档位与开关脱钩（K2-A 的偏离）。
func TestPaymentChannelImageTierIsNotPublic(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	out, err := h.svc.AddPaymentChannel(h.ctx, h.actor(alice), media.AddPaymentChannelInput{
		Body: pngBytes(t, 4, 4, color.RGBA{B: 200, A: 255}),
	})
	if err != nil {
		t.Fatalf("加收款码: %v", err)
	}
	hash := strings.TrimPrefix(out.Image, "/img/")
	got := h.scalar("SELECT visibility FROM images WHERE hash = $1", hash)
	if got != media.VisibilityLogin {
		t.Fatalf("收款码的档位必须是 VisibilityLogin(%d)，实际 %d —— public 会让「关掉展示」关不住图",
			media.VisibilityLogin, got)
	}
}
