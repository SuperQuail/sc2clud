package media_test

import (
	"errors"
	"image/color"
	"strings"
	"sync"
	"testing"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/media"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/image"
)

// 同一张图上传两次：images 只有一行、refcount=2、磁盘只有一份文件、两次 hash 相同。
func TestUploadAvatarDedupesAndRefcounts(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	actor := h.actor(alice)
	body := pngBytes(t, 8, 8, color.RGBA{R: 10, G: 20, B: 30, A: 255})

	first, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{Body: body})
	if err != nil {
		t.Fatalf("第一次上传: %v", err)
	}
	if !first.Created || first.URL != "/img/"+first.Hash {
		t.Fatalf("第一次应当是新建且带 URL: %+v", first)
	}
	second, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{Body: body})
	if err != nil {
		t.Fatalf("第二次上传: %v", err)
	}
	if second.Created || second.Hash != first.Hash {
		t.Fatalf("同内容再传一次不该新建: %+v", second)
	}

	if n := h.scalar("SELECT count(*) FROM images"); n != 1 {
		t.Fatalf("images 只该有一行，实际 %d", n)
	}
	// 第二次是 no-op（内容没变），所以引用计数还是 1
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", first.Hash); n != 1 {
		t.Fatalf("refcount 应当是 1（内容没变不重写），实际 %d", n)
	}
	if got := h.text("SELECT avatar_hash FROM users WHERE id = $1", alice.ID); got != first.Hash {
		t.Fatalf("users.avatar_hash 没写对: %q", got)
	}
	if n := h.countFiles(); n != 1 {
		t.Fatalf("磁盘上只该有一个文件，实际 %d", n)
	}

	// 换一张：新的 +1、旧的 −1，旧行归零（等 GC）
	other := pngBytes(t, 9, 9, color.RGBA{R: 200, A: 255})
	third, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{Body: other})
	if err != nil {
		t.Fatalf("换图: %v", err)
	}
	if !third.Created || third.Hash == first.Hash {
		t.Fatalf("换图应当是新建: %+v", third)
	}
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", first.Hash); n != 0 {
		t.Fatalf("旧图应当归零，实际 %d", n)
	}
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", third.Hash); n != 1 {
		t.Fatalf("新图应当为 1，实际 %d", n)
	}
}

// 清除头像：置 NULL 并给旧图 −1；没有头像时是 no-op（幂等）。
func TestClearAvatarIsIdempotent(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	actor := h.actor(alice)
	body := pngBytes(t, 4, 4, color.RGBA{B: 255, A: 255})
	res, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{Body: body})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.ClearAvatar(h.ctx, actor); err != nil {
		t.Fatalf("清除: %v", err)
	}
	if got := h.scalar("SELECT count(*) FROM users WHERE id = $1 AND avatar_hash IS NULL", alice.ID); got != 1 {
		t.Fatal("avatar_hash 必须置空")
	}
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", res.Hash); n != 0 {
		t.Fatalf("旧图应当归零，实际 %d", n)
	}
	if err := h.svc.ClearAvatar(h.ctx, actor); err != nil {
		t.Fatalf("再清一次必须幂等: %v", err)
	}
}

// 超限与格式：SVG 必须被拒（它可以内嵌脚本）；超上限给 media.too_large。
func TestUploadRejectsBadAndTooLarge(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	actor := h.actor(alice)

	svg := []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")
	_, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{Body: svg})
	if !hasCode(err, "media.bad_type") {
		t.Fatalf("SVG 必须被拒，实际 %v", err)
	}
	if n := h.scalar("SELECT count(*) FROM images"); n != 0 {
		t.Fatalf("被拒的图不许落库，实际 %d 行", n)
	}

	// 判限额看的是**读到的真实字节数**，与画的内容无关：512×512 的纯色 PNG 压缩后只有几 KB，
	// 所以这里手工拼一个超 64KiB 的合法 PNG（魔数在，额度也超）。
	big := append(pngBytes(t, 1, 1, color.RGBA{A: 255}), make([]byte, 70<<10)...)
	if _, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{Body: big}); !hasCode(err, "media.too_large") {
		t.Fatalf("超 64KiB 必须 media.too_large，实际 %v", err)
	}
	if n := h.scalar("SELECT count(*) FROM images"); n != 0 {
		t.Fatalf("超限的图不许登记，实际 %d 行", n)
	}
}

// 未激活的账号写操作一律被挡（拍板 §9.4 的唯一写闸门）。
func TestUploadRequiresActivation(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	actor := h.actor(alice)
	actor.Activated = false
	if _, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{
		Body: pngBytes(t, 4, 4, color.RGBA{A: 255}),
	}); !hasCode(err, "auth.not_activated") {
		t.Fatalf("未激活必须被挡，实际 %v", err)
	}
}

// 配图：作者可以贴；非作者不行；第 10 张给 media.limit_reached。
func TestAttachTopicImageLimitsAndPermission(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	bob := h.newUser("bob")
	topicID, _ := h.newTopic(alice, "normal")
	aliceActor := h.actor(alice, authz.PermTopicCreate)

	for i := 0; i < 9; i++ {
		out, err := h.svc.AttachTopicImage(h.ctx, aliceActor, media.AttachTopicImageInput{
			TopicPublicID: topicID,
			Body:          pngBytes(t, 4+i, 4, color.RGBA{R: uint8(i * 20), A: 255}),
		})
		if err != nil {
			t.Fatalf("第 %d 张: %v", i+1, err)
		}
		if out.Sort != i {
			t.Fatalf("第 %d 张的 sort 应当是 %d，实际 %d", i+1, i, out.Sort)
		}
	}
	_, err := h.svc.AttachTopicImage(h.ctx, aliceActor, media.AttachTopicImageInput{
		TopicPublicID: topicID,
		Body:          pngBytes(t, 5, 5, color.RGBA{G: 255, A: 255}),
	})
	if !hasCode(err, "media.limit_reached") {
		t.Fatalf("第 10 张必须 ErrLimitReached，实际 %v", err)
	}

	// 非作者（也没有 topic.delete.any）：403，且不落库
	before := h.scalar("SELECT count(*) FROM topic_images")
	_, err = h.svc.AttachTopicImage(h.ctx, h.actor(bob, authz.PermTopicCreate), media.AttachTopicImageInput{
		TopicPublicID: topicID,
		Body:          pngBytes(t, 6, 6, color.RGBA{B: 255, A: 255}),
	})
	if !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("非作者必须 403，实际 %v", err)
	}
	if after := h.scalar("SELECT count(*) FROM topic_images"); after != before {
		t.Fatalf("被拒的配图不许落库: %d -> %d", before, after)
	}

	// 删除：作者可以删掉其中一张，引用计数跟着 −1
	hash := h.text("SELECT image_hash FROM topic_images WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1) ORDER BY sort LIMIT 1", topicID)
	if err := h.svc.DetachTopicImage(h.ctx, aliceActor, media.DetachTopicImageInput{
		TopicPublicID: topicID, Hash: hash,
	}); err != nil {
		t.Fatalf("删图: %v", err)
	}
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", hash); n != 0 {
		t.Fatalf("删掉的图应当归零，实际 %d", n)
	}
	// 再删一次：404（不泄漏「这张图存在过」）
	if err := h.svc.DetachTopicImage(h.ctx, aliceActor, media.DetachTopicImageInput{
		TopicPublicID: topicID, Hash: hash,
	}); !hasCode(err, "media.not_found") {
		t.Fatalf("重复删除必须 404，实际 %v", err)
	}
}

// 并发贴第 9 张：主题行锁必须让一个成功一个失败（否则会插出 10 张）。
func TestAttachTopicImageConcurrent(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	topicID, topicInternal := h.newTopic(alice, "normal")
	actor := h.actor(alice, authz.PermTopicCreate)
	for i := 0; i < 8; i++ {
		if _, err := h.svc.AttachTopicImage(h.ctx, actor, media.AttachTopicImageInput{
			TopicPublicID: topicID,
			Body:          pngBytes(t, 4+i, 4, color.RGBA{R: uint8(i), A: 255}),
		}); err != nil {
			t.Fatalf("预置第 %d 张: %v", i+1, err)
		}
	}

	var wg sync.WaitGroup
	results := make([]error, 2)
	bodies := [][]byte{
		pngBytes(t, 30, 30, color.RGBA{R: 1, G: 2, B: 3, A: 255}),
		pngBytes(t, 31, 31, color.RGBA{R: 4, G: 5, B: 6, A: 255}),
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := h.svc.AttachTopicImage(h.ctx, actor, media.AttachTopicImageInput{
				TopicPublicID: topicID, Body: bodies[i],
			})
			results[i] = err
		}(i)
	}
	wg.Wait()

	ok, limited := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			ok++
		case hasCode(err, "media.limit_reached"):
			limited++
		default:
			t.Fatalf("并发结果只允许「成功」或「超限」，实际 %v", err)
		}
	}
	if ok != 1 || limited != 1 {
		t.Fatalf("并发第 9 张必须一成一败，实际 ok=%d limited=%d", ok, limited)
	}
	if n := h.scalar("SELECT count(*) FROM topic_images WHERE topic_id = $1", topicInternal); n != 9 {
		t.Fatalf("最终必须是 9 张，实际 %d", n)
	}
}

// 可见性三档 × 三种身份：任何一格都不是 404，拒绝时给占位图 + no-store。
func TestFetchImageVisibility(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	bob := h.newUser("bob")
	if err := h.putImage(h.actor(alice), pngBytes(t, 5, 5, color.RGBA{A: 255}), media.VisibilityPrivate); err != nil {
		t.Fatalf("放一张私有图: %v", err)
	}
	hash := h.text("SELECT hash FROM images LIMIT 1")

	cases := []struct {
		name  string
		actor *authz.Actor
		allow bool
	}{
		{"所有者", h.actor(alice), true},
		{"超管", &authz.Actor{UserID: bob.ID, Status: "active", Activated: true, IsSuper: true}, true},
		{"持 reward.verify", h.actor(bob, authz.PermRewardVerify), true},
		{"无关登录用户", h.actor(bob), false},
		{"游客", nil, false},
	}
	for _, c := range cases {
		out, err := h.svc.FetchImage(h.ctx, c.actor, hash)
		if err != nil {
			t.Fatalf("%s: 可见性不足不许报错（会变成裂图），实际 %v", c.name, err)
		}
		if c.allow {
			if out.Placeholder != nil || !out.Cache || out.Path == "" {
				t.Fatalf("%s 应当直出: %+v", c.name, out)
			}
			if out.Mime != "image/png" {
				t.Fatalf("%s 的 Content-Type 必须由 Go 给对，实际 %q", c.name, out.Mime)
			}
			continue
		}
		if out.Placeholder == nil || out.Cache || out.Path != "" {
			t.Fatalf("%s 应当拿到占位图 + no-store: %+v", c.name, out)
		}
	}

	// 格式不对：400，不是 404
	if _, err := h.svc.FetchImage(h.ctx, nil, "not-a-hash"); !hasCode(err, "media.bad_type") {
		t.Fatalf("hash 格式错必须 400，实际 %v", err)
	}
	// 没有这行：404（格式合法但库里没有）
	if _, err := h.svc.FetchImage(h.ctx, nil, strings.Repeat("a", 64)); !hasCode(err, "media.not_found") {
		t.Fatalf("不存在的图必须 404，实际 %v", err)
	}
}

// 收款码：每用户 ≤5；删除按归属判定（别人的删不到）。
func TestPaymentChannels(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	bob := h.newUser("bob")
	actor := h.actor(alice)

	var lastID string
	for i := 0; i < 5; i++ {
		out, err := h.svc.AddPaymentChannel(h.ctx, actor, media.AddPaymentChannelInput{
			Label: "",
			Body:  pngBytes(t, 4+i, 4, color.RGBA{R: uint8(i), A: 255}),
		})
		if err != nil {
			t.Fatalf("第 %d 张收款码: %v", i+1, err)
		}
		if out.Label != "收款码" {
			t.Fatalf("空 label 必须回落成「收款码」，实际 %q", out.Label)
		}
		if out.ID == "" {
			t.Fatal("必须给 public_id")
		}
		lastID = out.ID
	}
	if _, err := h.svc.AddPaymentChannel(h.ctx, actor, media.AddPaymentChannelInput{
		Body: pngBytes(t, 9, 9, color.RGBA{G: 1, A: 255}),
	}); !hasCode(err, "media.limit_reached") {
		t.Fatalf("第 6 张必须 ErrLimitReached，实际 %v", err)
	}

	list, err := h.svc.ListPaymentChannels(h.ctx, actor, "")
	if err != nil || len(list) != 5 {
		t.Fatalf("本人应当看到 5 张，实际 %d err=%v", len(list), err)
	}
	// 按 public_id 看别人的（reward 的渠道读端点会用到）
	if list2, err := h.svc.ListPaymentChannels(h.ctx, actor, alice.PublicID); err != nil || len(list2) != 5 {
		t.Fatalf("按 public_id 查应当一样是 5 张，实际 %d err=%v", len(list2), err)
	}

	// 别人删不掉：404
	if err := h.svc.DeletePaymentChannel(h.ctx, h.actor(bob), lastID); !hasCode(err, "media.not_found") {
		t.Fatalf("删别人的收款码必须 404，实际 %v", err)
	}
	// 本人删：204 语义（无错误），引用计数 −1
	hash := h.text("SELECT image_hash FROM payment_channels WHERE public_id = $1", lastID)
	if err := h.svc.DeletePaymentChannel(h.ctx, actor, lastID); err != nil {
		t.Fatalf("删自己的: %v", err)
	}
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", hash); n != 0 {
		t.Fatalf("删掉的收款码应当归零，实际 %d", n)
	}
}

// image:gc：归零满一小时才回收；默认头像池里的不回收；文件与行一起删。
func TestGCImages(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	actor := h.actor(alice)
	res, err := h.svc.UploadAvatar(h.ctx, actor, media.UploadAvatarInput{
		Body: pngBytes(t, 7, 7, color.RGBA{R: 9, A: 255}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.ClearAvatar(h.ctx, actor); err != nil {
		t.Fatal(err)
	}

	// 刚归零：还没到一小时，不回收
	if err := h.svc.GCImages(h.ctx, nil); err != nil {
		t.Fatalf("gc: %v", err)
	}
	if n := h.scalar("SELECT count(*) FROM images"); n != 1 {
		t.Fatal("归零不满一小时不许回收")
	}

	// 把它推进两小时前 + 放进默认头像池：仍然不回收
	if _, err := h.pool.Exec(h.ctx,
		"UPDATE images SET updated_at = now() - interval '2 hours' WHERE hash = $1", res.Hash); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, "INSERT INTO default_avatars (hash, sort) VALUES ($1, 0)", res.Hash); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.GCImages(h.ctx, nil); err != nil {
		t.Fatal(err)
	}
	if n := h.scalar("SELECT count(*) FROM images WHERE hash = $1", res.Hash); n != 1 {
		t.Fatal("默认头像池里的图不许回收")
	}
	if n := h.countFiles(); n != 1 {
		t.Fatal("池子里的图文件也要留着")
	}

	// 移出池子 → 回收：行与文件都没了
	if _, err := h.pool.Exec(h.ctx, "DELETE FROM default_avatars WHERE hash = $1", res.Hash); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.GCImages(h.ctx, nil); err != nil {
		t.Fatal(err)
	}
	if n := h.scalar("SELECT count(*) FROM images WHERE hash = $1", res.Hash); n != 0 {
		t.Fatal("该回收的行必须删掉")
	}
	if n := h.countFiles(); n != 0 {
		t.Fatalf("该回收的文件必须删掉，实际剩 %d", n)
	}
	// 幂等：再跑一次不报错
	if err := h.svc.GCImages(h.ctx, nil); err != nil {
		t.Fatalf("重复 gc 必须幂等: %v", err)
	}
}

// 给别的域的两个方法：引用计数 ±1，且必须与引用行同事务（回滚后计数不变）。
func TestIncDecRefTxRollsBack(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")
	if err := h.putImage(h.actor(alice), pngBytes(t, 3, 3, color.RGBA{A: 255}), media.VisibilityPublic); err != nil {
		t.Fatal(err)
	}
	hash := h.text("SELECT hash FROM images LIMIT 1")

	tx, err := h.db.Tx(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.IncRefTx(h.ctx, tx, image.Hash(hash)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", hash); n != 1 {
		t.Fatalf("事务回滚后引用计数不许变，实际 %d", n)
	}

	if err := db.WithTx(h.ctx, h.db, func(tx *ent.Tx) error {
		return h.svc.DecRefTx(h.ctx, tx, image.Hash(hash))
	}); err != nil {
		t.Fatal(err)
	}
	if n := h.scalar("SELECT refcount FROM images WHERE hash = $1", hash); n != 0 {
		t.Fatalf("提交后应当归零，实际 %d", n)
	}
}

// hasCode 按错误码判定：WithMsg 造的是新值，不是那批包级哨兵（handler 也是按 code 判的）。
func hasCode(err error, code string) bool {
	var ae *apperr.Error
	return errors.As(err, &ae) && ae.Code == code
}
