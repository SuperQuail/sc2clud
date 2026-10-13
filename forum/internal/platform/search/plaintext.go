package search

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// PlainText 把 HTML 变成用于索引的纯文本：去标签、丢 script/style 内容、解实体、折叠空白。
//
// 归属按拍板 §8.9：它是搜索的输入预处理，不是 forum 的业务。
// 输入是清洗过的正文 HTML（bluemonday 之后），所以这里不做安全判断，只做文本化。
//
// 标签**不**当词边界（只有块级标签出一个空格）：正文里 <em>大</em>吉 出来的仍是「大吉」，
// 分词器切段后才有这个 bigram。给每个标签插空格会把 bigram 全切碎，两字搜索直接失效。
func PlainText(src string) string {
	var b strings.Builder
	b.Grow(len(src))
	skip := false // script / style 里不是正文
	space := false
	put := func(r rune) {
		if unicode.IsSpace(r) {
			space = b.Len() > 0
			return
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	for i := 0; i < len(src); {
		if src[i] == '<' {
			end := strings.IndexByte(src[i:], '>')
			if end < 0 {
				break // 没有闭合的 '<'：剩下的都不是标签
			}
			tag := tagName(src[i+1 : i+end])
			switch tag {
			case "script", "style":
				skip = true
			case "/script", "/style":
				skip = false
			}
			if !skip && blockTag[strings.TrimPrefix(tag, "/")] {
				space = b.Len() > 0
			}
			i += end + 1
			continue
		}
		if src[i] == '&' {
			txt, size := decodeEntity(src[i:])
			i += size
			if !skip {
				// 把整个实体合成一个 rune 交给 put：逐字符喂会把 "&amp;" 里的 'a' 当成正文，
				// 于是 & 两侧的空格判定全乱（实测出来的，见 TestPlainText）。
				put(decodeRune(txt))
			}
			continue
		}
		r, size := utf8.DecodeRuneInString(src[i:])
		i += size
		if !skip {
			put(r)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

var (
	numericEntity = regexp.MustCompile("^&#(?:x[0-9A-Fa-f]{1,6}|[0-9]{1,7});")
	namedEntity   = regexp.MustCompile("^&[A-Za-z][A-Za-z0-9]{1,9};")
)

// decodeEntity 解 src 开头的一个实体（src 以 '&' 开始），返回文本与吃掉的字节数。
// 认不出就返回 "&" 与 1：调用方把它当标点，正文里那个 & 本身不是内容字符。
func decodeEntity(src string) (string, int) {
	if loc := numericEntity.FindString(src); loc != "" {
		body := loc[2 : len(loc)-1]
		base := 10
		if body[0] == 'x' {
			base, body = 16, body[1:]
		}
		if n, err := strconv.ParseInt(body, base, 32); err == nil && n > 0 && n <= unicode.MaxRune {
			return string(rune(n)), len(loc)
		}
		return " ", len(loc) // 解不出字符（代理区之类）就当空白，不能把 "&#x;" 塞进正文
	}
	if loc := namedEntity.FindString(src); loc != "" {
		name := loc[1 : len(loc)-1]
		if txt, ok := entities[name]; ok {
			return txt, len(loc)
		}
		return " ", len(loc) // 认不出的命名实体也是标点，不能把 "&foo;" 留在正文里
	}
	return "&", 1
}

// tagName 取标签名（小写）。闭合标签保留前缀 '/'，因为开关 script/style 靠它区分。
// decodeRune 把解出来的实体文本折成一个 rune 交给 put。
// 多码点的实体（很少见）取第一个码点：搜索索引里不需要保留它。
func decodeRune(txt string) rune {
	for _, r := range txt {
		return r
	}
	return ' '
}

func tagName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || s[0] == '!' || s[0] == '?' {
		return ""
	}
	closing := s[0] == '/'
	if closing {
		s = strings.TrimLeft(s, "/")
	}
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case ' ', '\t', '\n', '\r', '/':
			s = s[:i]
			i = len(s)
		}
	}
	if closing {
		return "/" + strings.ToLower(s)
	}
	return strings.ToLower(s)
}

// 只列 HTML 转义里常见的那几个：其余实体的解码结果本身就是内容字符或标点，
// 不解码与解码后的正文一致，多列反而多一处真源。
var entities = map[string]string{
	"nbsp": " ", "ensp": " ", "emsp": " ", "thinsp": " ",
	"quot": "\"", "apos": "'",
	"ldquo": "\u201c", "rdquo": "\u201d", "hellip": "\u2026",
	"mdash": "\u2014", "ndash": "\u2013",
	"lt": "<", "gt": ">", "amp": "&",
}

// 块级标签出空格：段落之间的词不该粘成一个词素。
var blockTag = map[string]bool{
	"p": true, "div": true, "br": true, "li": true, "ul": true, "ol": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"blockquote": true, "pre": true, "tr": true, "td": true, "th": true, "table": true, "hr": true,
}
