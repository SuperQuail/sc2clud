package mail

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// 模板必须真的带验证码、主题不能为空、HTML 必须转义用户输入。
func TestRenderEachKind(t *testing.T) {
	for _, kind := range []string{"verify_email", "reset_password", "test", "notice"} {
		m, err := Render(kind, Data{SiteName: "示例站", Nickname: "阿甲", Code: "483920", Title: "你的主题已通过", Body: "正文", Link: "https://example.com/t/1"})
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if m.Subject == "" || m.HTML == "" || m.Text == "" {
			t.Fatalf("%s: 主题/HTML/纯文本都不能为空: %+v", kind, m)
		}
		if !strings.Contains(m.HTML, "示例站") {
			t.Errorf("%s: HTML 里没有站名", kind)
		}
		if strings.Contains(m.HTML, "{{define") {
			t.Errorf("%s: 模板骨架漏进了输出", kind)
		}
	}
}

// 验证码类模板没有 Code 就是调用方的代码 bug：必须报错，不能发出一封没有码的信。
func TestRenderRejectsMissingFields(t *testing.T) {
	if _, err := Render("verify_email", Data{}); err == nil {
		t.Fatal("verify_email 缺验证码必须报错")
	}
	if _, err := Render("notice", Data{Body: "x"}); err == nil {
		t.Fatal("notice 缺标题必须报错")
	}
	if _, err := Render("nope", Data{}); err == nil {
		t.Fatal("不认识的模板必须报错")
	}
}

// 正文里的尖括号必须被转义（模板只接收结构体，禁止拼接用户输入的 HTML，v2 §8.5）。
func TestRenderEscapesUserInput(t *testing.T) {
	m, err := Render("notice", Data{Title: "t", Body: "<script>alert(1)</script>", Nickname: "<b>x</b>"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(m.HTML, "<script>") || strings.Contains(m.HTML, "<b>x</b>") {
		t.Fatalf("用户输入没被转义: %s", m.HTML)
	}
	if !strings.Contains(m.Text, "<script>alert(1)</script>") {
		t.Fatal("纯文本替身里应当保留原样（纯文本没有转义概念）")
	}
}

// 分类函数的判定就是 Router「换账号 / 熔断 / 放弃」的依据，四条都要钉住。
func TestClassify(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want error
	}{
		{"429", &httpError{code: 429, body: "rate limited"}, ErrQuotaExceeded},
		{"500", &httpError{code: 500, body: "boom"}, ErrTemporary},
		{"422", &httpError{code: 422, body: "bad address"}, ErrPermanent},
		{"已经分类过的原样返回", fmtQuota(), ErrQuotaExceeded},
		{"认不出来的按临时", errors.New("???"), ErrTemporary},
	}
	for _, c := range cases {
		if got := Classify(c.err); !errors.Is(got, c.want) {
			t.Errorf("%s: Classify = %v, 想要 %v", c.name, got, c.want)
		}
	}
}

func fmtQuota() error { return fmt.Errorf("wrap: %w", ErrQuotaExceeded) }
