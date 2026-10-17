package media_test

import (
	"image/color"
	"strings"
	"testing"

	"forum/internal/media"
)

// D24（用户 2026-10-15 实测）：收款码**上传后要默认显示**。
//
// 现状：档位（images.visibility=登录可见）由作者侧的 `user_donation_settings.show_channels` 在**读路径**上
// 放开（见 channel_visibility_test.go），而那一列是 0011 迁移的 DEFAULT false、建行时也写 false ——
// 于是用户传完码，别人主页上**什么都没有**，他还得摸到设置页去开一个自己不知道存在的开关。
//
// 改哪一边（**后端**，不是前端初值）：默认值只有在「行不存在」时才轮得到，
// 而「传了码」这件事本身就该把开关打开 —— 用户刚做完的那个动作，是唯一能说明他想要什么的信号。
// 前端初值改不了它：GET /me/donation-settings 回的 show_channels 是服务端的值，
// 前端把它显示成开只是画了一颗骗人的开关（点了保存才生效，且用户不知道要点）。
//
// 两条证据：① 行在库里已经是 true；② 游客真拿得到图（档位按开关放开，见 channel_visibility_test.go）。
func TestPaymentChannelUploadTurnsDisplayOn(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")

	if _, err := h.svc.AddPaymentChannel(h.ctx, h.actor(alice), media.AddPaymentChannelInput{
		Body: pngBytes(t, 6, 6, color.RGBA{G: 200, A: 255}),
	}); err != nil {
		t.Fatalf("加收款码: %v", err)
	}

	// 旧行为：user_donation_settings 里根本没有行（或有一行 show_channels=false）→ 这里读到 0。
	if got := h.scalar(`SELECT count(*) FROM user_donation_settings
		WHERE user_id = $1 AND show_channels`, alice.ID); got != 1 {
		t.Fatalf("上传收款码后 show_channels 必须是 true（上传即默认显示），实际匹配行数 %d", got)
	}
}

// 同一条改动的**外部可见**证据：开关开着的直接后果是「游客真拿得到字节」。
// 只断言库里那一列会漏掉「列对了但读路径没放开」——那正是收款码 404 的老病。
func TestPaymentChannelUploadMakesImagePublicToGuests(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	out, err := h.svc.AddPaymentChannel(h.ctx, h.actor(alice), media.AddPaymentChannelInput{
		Body: pngBytes(t, 5, 5, color.RGBA{R: 200, A: 255}),
	})
	if err != nil {
		t.Fatalf("加收款码: %v", err)
	}
	hash := strings.TrimPrefix(out.Image, "/img/")

	got, err := h.svc.FetchImage(h.ctx, nil, hash)
	if err != nil {
		t.Fatalf("取图不许报错（会变成裂图），实际 %v", err)
	}
	if got.Placeholder != nil {
		t.Fatalf("上传即默认显示：游客必须拿到真图，实际是占位图 %+v", got)
	}
}
