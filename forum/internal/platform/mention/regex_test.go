package mention

import "testing"

// 钉住 d4 §5.6 的 Re 逐字不变。
//
// 根因：正则里 `\[` / `\(` 这类转义掉一个反斜杠时，**分组结构**会跟着变——
// 报出来的是「unexpected )」「missing closing )」，与「少了个反斜杠」毫无关系；
// 更糟的是有些写法照样能编译，只是不再匹配（静默失效）。
// 所以这里钉住取值，并用一个真实提及串证明它真的匹配。
func TestBodyReIsSpec(t *testing.T) {
	const want = `\[@([^\]\n]{1,20})\]\(mention:(\d{1,18})\)`
	if got := BodyRe.String(); got != want {
		t.Fatalf("BodyRe 与 d4 §5.6 的 Re 漂移了\n got: %q\nwant: %q", got, want)
	}
	m := BodyRe.FindStringSubmatch("[@唐天](mention:123)")
	if m == nil || m[1] != "唐天" || m[2] != "123" {
		t.Fatalf("Re 匹配不出昵称与 id: %q", m)
	}
}
