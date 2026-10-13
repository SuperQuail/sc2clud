package main

import (
	"fmt"

	"github.com/microcosm-cc/bluemonday"
)

func main() {
	p := bluemonday.UGCPolicy()
	p.AllowURLSchemes("mention")
	fmt.Printf("+scheme: %q\n", p.Sanitize(`<a href="mention:123" data-mention="123">@x</a>`))
	fmt.Printf("+scheme js: %q\n", p.Sanitize(`<a href="javascript:alert(1)">b</a>`))
	fmt.Printf("+scheme rel: %q\n", p.Sanitize(`<a href="mention:123" rel="nofollow">x</a>`))

	p2 := bluemonday.UGCPolicy()
	p2.AllowURLSchemes("mention")
	p2.AllowAttrs("data-mention").OnElements("a")
	fmt.Printf("+attr: %q\n", p2.Sanitize(`<a href="mention:123" data-mention="123">@x</a>`))
	fmt.Printf("+attr img onerror: %q\n", p2.Sanitize(`<img src=x onerror=alert(1)>\n<scr<script>ipt>alert(1)</scr</script>ipt>`))
	fmt.Printf("+attr script: %q\n", p2.Sanitize(`<script>alert(1)</script>hi`))
}
