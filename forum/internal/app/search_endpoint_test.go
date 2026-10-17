package app

import (
	"testing"

	"forum/internal/platform/search"
)

// 搜索游标最容易错的地方是**丢档位**：loose 的 rank 分布与 exact 不同，
// 翻页喂错档位就是错序结果 —— 而错序不会报错，只会让人以为「搜索不准」。
// 所以这里钉死的一件事：**tier 必须原样往返**。
func TestSearchCursorRoundTrip(t *testing.T) {
	rank := float32(0.8125)
	id := int64(4242)
	cur := encodeSearchCursor(search.Page{Tier: search.TierLoose, NextCursorRank: &rank, NextCursorID: &id})
	if cur == "" {
		t.Fatal("有 rank 与 id 就应该给出游标")
	}
	gotRank, gotID, gotTier, err := decodeSearchCursor(cur)
	if err != nil {
		t.Fatal(err)
	}
	if gotRank != rank || gotID != id || gotTier != search.TierLoose {
		t.Fatalf("往返后应当逐字相同：rank %v/%v id %d/%d tier %q/%q", rank, gotRank, id, gotID, search.TierLoose, gotTier)
	}

	// 没有下一页时必须返回空串，而不是一个指向第 0 行的坏游标
	if empty := encodeSearchCursor(search.Page{Tier: search.TierExact}); empty != "" {
		t.Fatalf("到底了就该回空游标，现在给了 %q", empty)
	}

	// 坏游标必须被拒（400），不能静默当成第一页
	for _, bad := range []string{"!!!", "e30", encodeSearchCursor(search.Page{})} {
		if bad == "" {
			continue
		}
		if _, _, _, err := decodeSearchCursor(bad); err == nil {
			t.Fatalf("游标 %q 应当被拒", bad)
		}
	}
}
