package mention

import (
	"errors"
	"testing"

	"forum/internal/platform/apperr"
)

func TestParseOrderAndDedup(t *testing.T) {
	got := Parse("hi [@a](mention:5) and [@b](mention:9) then [@a](mention:5) 结束")
	want := []int64{5, 9}
	if len(got) != len(want) {
		t.Fatalf("Parse = %v, 想要 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Parse = %v, 想要 %v（顺序必须按出现顺序）", got, want)
		}
	}
}

func TestParseIgnoresNonMentions(t *testing.T) {
	for _, s := range []string{
		"[@a](mention:)",
		"[@a](mention:abc)",
		"[@a](mention:0)",
		"[@a](https://example.com)",
		`[@a](mention:1)`,
		"[@a](mention:1234567890123456789)", // 19 位，超出 bigint 的合理范围
	} {
		if got := Parse(s); len(got) != 0 {
			t.Errorf("Parse(%q) = %v, 想要空", s, got)
		}
	}
}

func TestCheckLimit(t *testing.T) {
	ids := make([]int64, MaxPerBody)
	if err := CheckLimit(ids); err != nil {
		t.Fatalf("%d 个提及应当在限内: %v", MaxPerBody, err)
	}
	ids = append(ids, 1)
	err := CheckLimit(ids)
	if err == nil {
		t.Fatalf("超过 %d 个提及必须报错", MaxPerBody)
	}
	var e *apperr.Error
	if !errors.As(err, &e) || e.Code != "content.bad_mention" || e.Status != 400 {
		t.Fatalf("错误码/状态不对: %v", err)
	}
}
