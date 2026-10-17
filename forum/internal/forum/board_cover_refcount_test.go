package forum

import (
	"context"
	"strings"
	"testing"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/image"
)

// board_cover_refcount_test.go（2026-10-14）：分区封面的**引用计数**。
//
// 为什么要有它：图片经 /me/cover 上传时那一行 refcount=1，而论坛域把 hash 挂到 boards.cover_hash 上时
// 既没 +1、换图/清空时也没 −1 —— GC 只收 refcount 归零的行，所以**换掉的旧分区封面永远留在盘上**。
// 这一层以前完全没有用例（跨域接线没人量），所以它一直没被发现。
//
// 用假 Media 记调用：真实 SQL（images.refcount ±1）由 media 域自己的用例量，
// 这里只钉「论坛域该在什么时候调、调了几次、传的哪个 hash」——**重复保存同一张图不许再加减**，
// 否则每保存一次就多欠一次，refcount 会漂到收不回去。

type fakeMedia struct {
	inc []string
	dec []string
}

func (f *fakeMedia) IncRefTx(_ context.Context, _ *ent.Tx, h image.Hash) error {
	f.inc = append(f.inc, string(h))
	return nil
}

func (f *fakeMedia) DecRefTx(_ context.Context, _ *ent.Tx, h image.Hash) error {
	f.dec = append(f.dec, string(h))
	return nil
}

func (f *fakeMedia) eq(inc, dec []string) bool {
	if len(f.inc) != len(inc) || len(f.dec) != len(dec) {
		return false
	}
	for i := range inc {
		if f.inc[i] != inc[i] {
			return false
		}
	}
	for i := range dec {
		if f.dec[i] != dec[i] {
			return false
		}
	}
	return true
}

func TestBoardCoverMaintainsImageRefcount(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("admin", true)
	uid := h.seedUser("boss", roleID, 1, true)
	actor := h.super(uid, roleID)

	fm := &fakeMedia{}
	svc := NewService(h.ent, h.clk, h.count, h.queue, Deps{
		Users: h.deps, Render: markdownish{}, Queue: h.queue, Counter: h.count, Media: fm,
	})

	// hash 必须过 images 的 ck_images_hash_fmt（64 位 hex）——它是「图片路径就是内容地址」的库级保证。
	h1, h2, empty := strings.Repeat("a", 64), strings.Repeat("b", 64), ""

	// boards.cover_hash 有外键指向 images(hash) → 图片行必须先存在。
	// 这条约束本身就是「没上传过的图挂不上去」的库级保证（实测：不插会报 23503）。
	for _, hash := range []string{h1, h2} {
		if _, err := h.pool.Exec(h.ctx, `
INSERT INTO images (hash, size, mime, width, height, refcount, visibility, created_at, updated_at)
VALUES ($1, 1, 'image/png', 1, 1, 1, 1, now(), now())`, hash); err != nil {
			t.Fatalf("插图片行 %s 失败: %v", hash, err)
		}
	}

	// 建分区带封面 → +1
	b, err := svc.CreateBoard(h.ctx, actor, CreateBoardInput{
		Slug: "cover-refcount", Name: "封面计数", CoverHash: &h1,
	})
	if err != nil {
		t.Fatalf("建分区失败: %v", err)
	}
	if !fm.eq([]string{h1}, nil) {
		t.Fatalf("挂封面必须 +1，实际 inc=%v dec=%v", fm.inc, fm.dec)
	}

	// 换成另一张 → 旧 −1、新 +1
	if _, err := svc.UpdateBoard(h.ctx, actor, b.ID, UpdateBoardInput{CoverHash: &h2}); err != nil {
		t.Fatal(err)
	}
	if !fm.eq([]string{h1, h2}, []string{h1}) {
		t.Fatalf("换封面必须旧−1新+1，实际 inc=%v dec=%v", fm.inc, fm.dec)
	}

	// 同一张再保存一次 → **不动计数**（否则 refcount 会漂）
	if _, err := svc.UpdateBoard(h.ctx, actor, b.ID, UpdateBoardInput{CoverHash: &h2}); err != nil {
		t.Fatal(err)
	}
	if !fm.eq([]string{h1, h2}, []string{h1}) {
		t.Fatalf("同一张封面重复保存不该加减，实际 inc=%v dec=%v", fm.inc, fm.dec)
	}

	// 清空 → 旧 −1
	if _, err := svc.UpdateBoard(h.ctx, actor, b.ID, UpdateBoardInput{CoverHash: &empty}); err != nil {
		t.Fatal(err)
	}
	if !fm.eq([]string{h1, h2}, []string{h1, h2}) {
		t.Fatalf("清空封面必须 −1，实际 inc=%v dec=%v", fm.inc, fm.dec)
	}

	// 已经空了再来一次 → 不动计数
	if _, err := svc.UpdateBoard(h.ctx, actor, b.ID, UpdateBoardInput{CoverHash: &empty}); err != nil {
		t.Fatal(err)
	}
	if !fm.eq([]string{h1, h2}, []string{h1, h2}) {
		t.Fatalf("重复清空不该再减，实际 inc=%v dec=%v", fm.inc, fm.dec)
	}

	// 只改别的字段 → 封面不动，计数也不动
	name := "改了名字"
	if _, err := svc.UpdateBoard(h.ctx, actor, b.ID, UpdateBoardInput{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if !fm.eq([]string{h1, h2}, []string{h1, h2}) {
		t.Fatalf("只改别的字段不该动封面计数，实际 inc=%v dec=%v", fm.inc, fm.dec)
	}
}

var _ = authz.Actor{}
