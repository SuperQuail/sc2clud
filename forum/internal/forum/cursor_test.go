package forum

import (
	"testing"
	"time"
)

// 游标是服务端自己发给自己的一串（§3.8）：装 k（排序键的字符串形式）与**内部** id。
func TestCursorRoundTrip(t *testing.T) {
	k := time.Date(2026, 10, 13, 12, 0, 0, 123456789, time.UTC)
	s := encodeCursor(k, 9223372036854775806)
	gotK, gotID, err := decodeCursor(s)
	if err != nil {
		t.Fatal(err)
	}
	if !gotK.Equal(k) {
		t.Fatalf("时间丢了精度: %s != %s", gotK, k)
	}
	// id 早过了 2^53：装成 JSON 数字会丢精度，所以它是字符串承载的。
	if gotID != 9223372036854775806 {
		t.Fatalf("id 丢了精度: %d", gotID)
	}
}

// 伪造 / 损坏的游标必须是 400，不能被静默当成「第一页」——那会让翻页悄悄回到开头。
func TestCursorInvalidIsBadRequest(t *testing.T) {
	for _, bad := range []string{"abc", "!!!", "eyJ4IjoxfQ", "e30"} {
		if _, _, err := decodeCursor(bad); err == nil {
			t.Fatalf("%q 应该报错", bad)
		}
	}
}

// 第一页的哨兵必须大于任何真实值：这就是「不许传 NULL」的落地（§3.8 规则 2）。
func TestSentinelIsGreaterThanRealValues(t *testing.T) {
	if !sentinelTime.After(time.Now().AddDate(50, 0, 0)) {
		t.Fatal("哨兵时间不够远")
	}
	if sentinelID != 9223372036854775807 {
		t.Fatalf("哨兵 id 必须是 MaxInt64，实际 %d", sentinelID)
	}
}

// limit 的默认与上限：不传用默认，传大了收敛（不做 400——条数是展示偏好）。
func TestLimitOf(t *testing.T) {
	cases := map[int]int{0: defaultLimit, -3: defaultLimit, 5: 5, 500: maxLimit}
	for in, want := range cases {
		if got := limitOf(in); got != want {
			t.Fatalf("limitOf(%d) = %d，期望 %d", in, got, want)
		}
	}
}
