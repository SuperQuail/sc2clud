// Package search 是搜索的**唯一**分词入口与两档查询的契约。
//
// 依据：d5-content.md §6、拍板 §8.5/§8.6；交接单 §1.2。
// 词素 = 单字 + 2-gram：单字与多字共用同一个 GIN，没有第二条数据路径。
package search

import (
	"strings"
	"unicode"
)

// MaxTokens 是词素上限：超出即截断，并记 Warn（留 tsvector 1MB 上限的余量）。
// 正文在写入口就有一万字上限，正常帖子到不了这里。
const MaxTokens = 20000

// Tokenize 是索引与查询**唯一**的分词入口——两边必须是同一个函数，否则搜不到。
//
//	Tokenize("难")           == "难"
//	Tokenize("大吉")         == "大 大吉 吉"
//	Tokenize("大吉大利")     == "大 大吉 吉 吉大 利 大利"
//	Tokenize("Hello, 世界!") == "h he e el l ll lo o 世 世界 界"
//
// 步骤（顺序即语义，见 d5 §6.4）：全角转半角 → 小写 → 按「内容字符」切段 →
// 每段按出现顺序产出「当前字、当前字起的 2-gram」→ 去重 → 空格连接。
// 切段而不是整串滑窗：整串会产出跨词的 "文搜" 这种无意义词素（「中文 搜索」）。
func Tokenize(s string) string {
	var (
		out  strings.Builder
		seen = make(map[string]struct{})
		run  []rune
	)
	emit := func(tok string) {
		if _, dup := seen[tok]; dup {
			return
		}
		if len(seen) >= MaxTokens {
			return
		}
		seen[tok] = struct{}{}
		if out.Len() > 0 {
			out.WriteByte(' ')
		}
		out.WriteString(tok)
	}
	flush := func() {
		for i, r := range run {
			emit(string(r))
			if i+1 < len(run) {
				emit(string(run[i : i+2]))
			}
		}
		run = run[:0]
	}
	for _, r := range s {
		c := unicode.ToLower(foldFullWidth(r))
		if !isContent(c) {
			flush()
			continue
		}
		run = append(run, c)
	}
	flush()
	return out.String()
}

// isContent 判定「内容字符」：CJK 表意文字（含扩展区）、假名、以及 unicode 意义上的字母数字。
// 其余（空白、标点、符号、emoji）都是分隔符。
//
// kana 的区间刻意写成 0x3040–0x30FF：它把 0x3000 表意空格也圈进来了，
// 而表意空格既不是字母也不是数字，所以下面那条兜底把它打回分隔符（d5 §6.4 第 3 步的原文区间）。
func isContent(r rune) bool {
	switch {
	case r >= 0x3400 && r <= 0x4DBF, // CJK 扩展 A
		r >= 0x4E00 && r <= 0x9FFF,   // CJK 基本区
		r >= 0xF900 && r <= 0xFAFF,   // CJK 兼容表意
		r >= 0x20000 && r <= 0x2FA1F, // CJK 扩展 B 及以后
		r >= 0x3040 && r <= 0x30FF:   // 平假名 / 片假名
		return true
	}
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// foldFullWidth 把全角 ASCII（U+FF01–U+FF5E）与全角空格折成半角，
// 否则「Ａ」与「a」是两个不同的词素，用户搜不到。
func foldFullWidth(r rune) rune {
	if r == 0x3000 {
		return ' '
	}
	if r >= 0xFF01 && r <= 0xFF5E {
		return r - 0xFEE0
	}
	return r
}
