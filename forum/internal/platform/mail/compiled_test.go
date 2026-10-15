package mail

import (
	"strings"
	"testing"
)

// CompileTemplate 是后台保存那一步的闸门（D37）：语法错 / 缺尾块 / 执行期错误
// 必须在**保存时**被挡住，错误原话带回并**定位到段与行**（人要能对着编辑框改）。
func TestCompileTemplateRejectsBadTemplate(t *testing.T) {
	cases := []struct {
		name string
		ov   Override
		want string // 错误必须包含的片段（模板名带段与行）
	}{
		{"html 语法错", Override{Subject: "s", HTMLBody: "&nbsp;\n<p>{{.Code}</p>"}, ":html:2"},
		{"html 孤立 {{end}}", Override{Subject: "s", HTMLBody: "<p>{{end}}</p>"}, ":html:1"},
		{"text 语法错", Override{Subject: "s", HTMLBody: "<p>s</p>", TextBody: "码 {{.Code)"} , ":text:1"},
		{"html 执行期字段错", Override{Subject: "s", HTMLBody: "<p>{{.Nickname.Missing}}</p>", TextBody: "t"}, ":html"},
		{"subject 执行期字段错", Override{Subject: "码 {{.Code.Missing}}", HTMLBody: "<p>s</p>", TextBody: "t"}, ":subject"},
	}
	for _, c := range cases {
		_, err := CompileTemplate("verify_email", c.ov)
		if err == nil {
			t.Errorf("%s: 编译必须失败（会红是这条用例的意义）", c.name)
			continue
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: 错误要能定位到 %q，实际 %q", c.name, c.want, err.Error())
		}
	}
}

// 批量字段测试里故意放不完整模板，编译器把空段当「不覆盖」：
// subject 空回落内置主题、text 空回落内置文本 —— 这就是预览「可选三覆盖」的语义。
func TestCompiledRender(t *testing.T) {
	c, err := CompileTemplate("verify_email", Override{
		Subject:  "你的验证码是 {{.Code}}",
		HTMLBody: "<p>你好 {{.Nickname}}，码是 {{.Code}}，{{.ExpiresIn}}内有效</p>",
		TextBody: "你好 {{.Nickname}} 码 {{.Code}} {{.ExpiresIn}}",
	})
	if err != nil {
		t.Fatal(err)
	}
	m, err := c.Render(Data{SiteName: "示例站", Nickname: "<script>alert(1)</script>", Code: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Subject != "你的验证码是 123456" {
		t.Fatalf("主题应插值验证码: %q", m.Subject)
	}
	if strings.Contains(m.HTML, "<script>") || !strings.Contains(m.HTML, "&lt;script&gt;") {
		t.Fatalf("昵称在 HTML 里必须被转义: %s", m.HTML)
	}
	if !strings.Contains(m.Text, "<script>alert(1)</script>") {
		t.Fatal("纯文本替身保留原样（纯文本没有转义概念）")
	}
	if !strings.Contains(m.HTML, "max-width:560px") {
		t.Fatal("HTML 应该仍然包在内置骨架（layout 不属于自定义范围）")
	}
	if !strings.Contains(m.HTML, "你好 &lt;script&gt;") {
		t.Fatalf("自定义正文没生效: %s", m.HTML)
	}
	// 兜底语义与内置同源：缺 Code / 缺站名照样走同一套校验
	if _, err := c.Render(Data{}); err == nil {
		t.Fatal("缺 Code 必须报错（调用方的代码 bug）")
	}
}

// 部分覆盖：只覆盖 html —— subject/text 都回落内置。
func TestCompiledRenderPartial(t *testing.T) {
	c, err := CompileTemplate("verify_email", Override{HTMLBody: "<p>只改了这一段 {{.Code}}</p>"})
	if err != nil {
		t.Fatal(err)
	}
	m, err := c.Render(Data{Code: "223344"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Subject != subjectOf["verify_email"] {
		t.Fatalf("subject 空 = 回落内置主题: %q", m.Subject)
	}
	if !strings.Contains(m.Text, "你的邮箱验证码是：223344") {
		t.Fatalf("text 空 = 回落内置文本: %s", m.Text)
	}
	if !strings.Contains(m.HTML, "只改了这一段 223344") {
		t.Fatalf("覆盖的那部分没生效: %s", m.HTML)
	}
}

// Builtin 的三段源编回去再渲一遍，必须和 Render 产物**逐字一致**：
// 这是「缺行回落 embed」语义的同 Deptrome（没有它回落就只是一句注释）。
func TestBuiltinSourcesRoundTrip(t *testing.T) {
	for kind := range subjectOf {
		ov, err := Builtin(kind)
		if err != nil {
			t.Fatal(err)
		}
		bysrc, err := CompileTemplate(kind, ov)
		if err != nil {
			t.Fatalf("%s: 内置源编不过: %v", kind, err)
		}
		d := Data{SiteName: "示例站", Nickname: "阿甲", Code: "483920", Title: "主题", Body: "正文", Link: "https://example.com"}
		a, err := Render(kind, d)
		if err != nil {
			t.Fatal(err)
		}
		b, err := bysrc.Render(d)
		if err != nil {
			t.Fatal(err)
		}
		if a != b {
			t.Fatalf("%s: 内置源渲染与 Render 不一致:\n  a=%+v\n  b=%+v", kind, a, b)
		}
	}
	if _, err := Builtin("nope"); err == nil {
		t.Fatal("不认识的模板必须报错")
	}
}
