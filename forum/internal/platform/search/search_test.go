package search

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// d5 §6.9 ①②：分词是纯函数，表驱动逐字节断言。
// want 全部手写（不用 helper 现算——现算等于把实现抄一遍，测不出错）。
func TestTokenize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{"难", "难"},
		{"a", "a"},
		{"大吉", "大 大吉 吉"},
		{"大吉大利", "大 大吉 吉 吉大 大利 利"},
		{"中文搜索", "中 中文 文 文搜 搜 搜索 索"},
		{"Hello, 世界!", "h he e el l ll lo o 世 世界 界"},
		{"ＡＢ", "a ab b"}, // 全角转半角之后小写
		{"大 吉", "大 吉"},   // 空格断开：不产出跨段的 bigram
		{"123", "1 12 2 23 3"},
	}
	for _, c := range cases {
		if got := Tokenize(c.in); got != c.want {
			t.Errorf("Tokenize(%q) got %q want %q", c.in, got, c.want)
		}
	}
}

// 标点是分隔符：它必须切断 bigram，且自己绝不进词素。
func TestTokenizePunctuationSeparates(t *testing.T) {
	got := Tokenize("成？就感")
	if got != "成 就 就感 感" {
		t.Fatalf("标点必须切断 bigram，实际 %q", got)
	}
	if strings.ContainsAny(got, "？?，,。.！!") {
		t.Fatalf("词素里不许出现标点: %q", got)
	}
}

func TestTokenizeIsDeterministic(t *testing.T) {
	corpus := []string{
		"大吉大利整合包", "第三章隐藏结局", "Hello, 世界!", "a", "难",
		"ＡＢＣ１２３", "成就感？？？", "Rust 与 Go 的性能对比",
	}
	for _, s := range corpus {
		first := Tokenize(s)
		for i := 0; i < 3; i++ {
			if got := Tokenize(s); got != first {
				t.Fatalf("Tokenize(%q) 不可重放: %q != %q", s, got, first)
			}
		}
	}
}

// 单字词素必须在 tokens 里：单字查询走的是同一个 GIN（R-D5-1）。
func TestTokenizeKeepsEveryContentChar(t *testing.T) {
	corpus := []string{"大吉大利整合包", "第三章隐藏结局", "Hello世界", "ＡＢ１２"}
	for _, s := range corpus {
		toks := Tokenize(s)
		have := map[string]bool{}
		for _, tok := range strings.Fields(toks) {
			have[tok] = true
		}
		for _, r := range s {
			c := unicode.ToLower(foldFullWidth(r))
			if !isContent(c) {
				continue
			}
			if !have[string(c)] {
				t.Fatalf("%q 的字 %q 没作为单字词素出现: %q", s, string(c), toks)
			}
		}
	}
}

func TestTokenizeTruncatesAtMaxTokens(t *testing.T) {
	// 4096 个互不相同的汉字（CJK 扩展 A 区），每个还带一个 bigram → 必然撞上限
	var b strings.Builder
	for i := 0; i < 20000; i++ {
		b.WriteRune(rune(0x3400 + i%0x4000))
	}
	got := Tokenize(b.String())
	if n := len(strings.Fields(got)); n != MaxTokens {
		t.Fatalf("应当在 %d 个词素处截断，实际 %d", MaxTokens, n)
	}
}

func TestPlainText(t *testing.T) {
	cases := []struct{ in, want string }{
		{"<p>你好</p><p>世界</p>", "你好 世界"},
		{"a<b>b</b>c", "abc"}, // 行内标签不是词边界：CJK 的 bigram 必须活下来
		{"<p>a</p><p>b</p>", "a b"},
		{"<script>alert(1)</script>正文", "正文"},
		{"<style>p{}</style>正文", "正文"},
		{"&nbsp;大吉&amp;大利", "大吉&大利"}, // &amp; 是正文里的一个字符，不是词边界
		{"大吉 &amp; 大利", "大吉 & 大利"},
		{"&unknown;正文", "正文"},
		{"&#22909;", "好"},
		{"<p></p>", ""},
		{"没有标签", "没有标签"},
	}
	for _, c := range cases {
		if got := PlainText(c.in); got != c.want {
			t.Errorf("PlainText(%q) got %q want %q", c.in, got, c.want)
		}
	}
}

// 分词器按码点走，遇到坏字节也不能崩。
func TestTokenizeInvalidUTF8(t *testing.T) {
	got := Tokenize(string([]byte{'a', 0xff, 'b'}))
	if !utf8.ValidString(got) {
		t.Fatalf("输出必须是合法 UTF-8: %q", got)
	}
	if !strings.Contains(got, "a") || !strings.Contains(got, "b") {
		t.Fatalf("坏字节两侧的字都要留下: %q", got)
	}
}
