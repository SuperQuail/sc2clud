package markdown

import (
	"strings"
	"testing"
)

// 拍板 §8.4 的实现第一步：先确认清洗策略会不会把 mention: 的 href 干掉。
// 这条红了就说明「清洗后按 href 改写」这条路不成立，得把改写挪进 renderer hook。
func TestUGCPolicyKeepsMentionHref(t *testing.T) {
	got := policy.Sanitize(`<p><a href="mention:123">@唐天</a></p>`)
	if !strings.Contains(got, `href="mention:123"`) {
		t.Fatalf("UGCPolicy 把 mention: 协议吃掉了，改写无处落脚: %q", got)
	}
	// 只放行 mention:，别的协议仍然被丢——放行面不能跟着变大。
	for _, bad := range []string{`javascript:alert(1)`, `data:text/html,x`, `vbscript:x`} {
		if out := policy.Sanitize(`<a href="` + bad + `">x</a>`); strings.Contains(out, "href") {
			t.Errorf("协议 %s 必须仍被丢掉，实际: %q", bad, out)
		}
	}
}

func TestRenderRewritesMention(t *testing.T) {
	html, err := Render("[@老名字](mention:42)", map[int64]string{42: "新名字"})
	if err != nil {
		t.Fatal(err)
	}
	want := `<a href="/u/42" data-mention="42">@新名字</a>`
	if !strings.Contains(html, want) {
		t.Fatalf("改写结果不对\n got: %s\nwant 含: %s", html, want)
	}
	if strings.Contains(html, "mention:") {
		t.Fatalf("mention: 协议不该出现在最终 HTML 里: %s", html)
	}
}

// 当前昵称查不到（用户已注销）→ 用链接文本里的快照。
func TestRenderMentionFallsBackToSnapshot(t *testing.T) {
	html, err := Render("[@旧名字](mention:7)", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, `data-mention="7">@旧名字</a>`) {
		t.Fatalf("快照兜底失效: %s", html)
	}
}

func TestRenderSanitizesScript(t *testing.T) {
	html, err := Render("hello <script>alert(1)</script> <img src=x onerror=alert(1)>", nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(html, "<script") || strings.Contains(html, "onerror") {
		t.Fatalf("XSS 没被清洗: %s", html)
	}
	if !strings.Contains(html, "<img") {
		t.Fatalf("图片标签本身该留下: %s", html)
	}
}

// 普通链接与代码块这类非提及内容不能被 DOM 往返改动。
func TestRenderKeepsNonMentionContent(t *testing.T) {
	src := "[a](https://example.com)\n\n```go\nx := 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
	html, err := Render(src, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`href="https://example.com"`,
		"<table>",
		"<code",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("往返后丢了 %q\n%s", want, html)
		}
	}
}

// 不是提及的链接一根手指都不能碰（data-mention 只加在 mention: 上）。
func TestRenderLeavesOtherLinksAlone(t *testing.T) {
	html, err := Render("[x](mention:) [y](mention:abc) [z](mention:0) [w](https://e.com)", map[int64]string{0: "零"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(html, "data-mention") {
		t.Fatalf("非法的 mention 值不该被当成提及: %s", html)
	}
	if !strings.Contains(html, `href="https://e.com"`) {
		t.Fatalf("普通链接被改动: %s", html)
	}
}
