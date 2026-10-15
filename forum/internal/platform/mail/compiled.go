package mail

import (
	"fmt"
	htmltemplate "html/template"
	"io"
	"strings"
	texttemplate "text/template"
)

// Override 是一份**自定义模板的三段源码**（后台存的就是这个，不存渲染结果）。
// 转义永远发生在渲染时的 Data 注入 —— 这里只管把源码编成可执行的模板。
type Override struct {
	Subject  string
	HTMLBody string
	TextBody string
}

// Compiled 是编译好的自定义模板。空段 = 该段**不覆盖**：Render 落回内置那份 ——
// 与「mail_templates 缺行回落 embed」是同一条语义（预览的「可选三覆盖」也靠它）。
type Compiled struct {
	kind    string
	subject *texttemplate.Template // nil = 用内置主题
	html    *htmltemplate.Template // nil = 用内置正文片段
	text    *texttemplate.Template // nil = 用内置纯文本
}

// CompileTemplate 把三段源码各自编译并**各空跑一遍**：语法错、缺尾块与「字段不存在」这类
// 执行期错误都必须在这一步报出来（后台存进一个会炸的模板 = 投递时 500，D37 拒收的就是这个）。
//
// 错误**原话**返回：text/template 与 html/template 的错误自带 template: 名字:行: 的行位，
// 模板名里带段名（subject/html/text），管理员把错误对着三份编辑框里的那一份看。
func CompileTemplate(kind string, ov Override) (*Compiled, error) {
	c := &Compiled{kind: kind}
	if s := strings.TrimSpace(ov.Subject); s != "" {
		t, err := texttemplate.New(kind + ":subject").Parse(ov.Subject)
		if err != nil {
			return nil, err
		}
		if err := t.Execute(io.Discard, sampleData); err != nil {
			return nil, err
		}
		c.subject = t
	}
	if s := strings.TrimSpace(ov.HTMLBody); s != "" {
		t, err := htmltemplate.New(kind + ":html").Parse(ov.HTMLBody)
		if err != nil {
			return nil, err
		}
		if err := t.Execute(io.Discard, sampleData); err != nil {
			return nil, err
		}
		c.html = t
	}
	if s := strings.TrimSpace(ov.TextBody); s != "" {
		t, err := texttemplate.New(kind + ":text").Parse(ov.TextBody)
		if err != nil {
			return nil, err
		}
		if err := t.Execute(io.Discard, sampleData); err != nil {
			return nil, err
		}
		c.text = t
	}
	return c, nil
}

// sampleData 是编译校验空跑用的样本：字段齐全、值无意义。Execute 的输出全进 io.Discard，
// 报错只看「字段名存不存在」，值本身不会出现在任何输出里。
var sampleData = Data{
	SiteName: "站名", Nickname: "昵称", Code: "000000", ExpiresIn: "10 分钟",
	Title: "标题", Body: "正文", Link: "https://example.com", From: "no-reply@example.com", Now: "2006-01-02 15:04",
}

// Render 用与内置 Render 完全相同的校验与兜底渲染一封信（投递与预览共用这一份）。
func (c *Compiled) Render(d Data) (Message, error) {
	builtinSubject, d, err := prepare(c.kind, d)
	if err != nil {
		return Message{}, err
	}
	subject, err := renderSubject(c.kind, c.subject, builtinSubject, d)
	if err != nil {
		return Message{}, err
	}
	text, err := renderText(c.kind, c.text, d)
	if err != nil {
		return Message{}, err
	}
	body, err := renderBody(c.kind, c.html, d)
	if err != nil {
		return Message{}, err
	}
	title := d.Title
	if title == "" {
		title = subject
	}
	html, err := execHTML("layout.html", layoutData{SiteName: d.SiteName, Title: title, Body: htmltemplate.HTML(body)})
	if err != nil {
		return Message{}, err
	}
	return Message{Subject: subject, Text: text, HTML: html}, nil
}

// renderSubject / renderText / renderBody：模板在就执行模板，不在就执行内置 —— 三个组成对。

func renderSubject(kind string, t *texttemplate.Template, fallback string, d Data) (string, error) {
	if t == nil {
		return fallback, nil
	}
	var b strings.Builder
	if err := t.Execute(&b, d); err != nil {
		return "", fmt.Errorf("mail: 渲染 %s:subject: %w", kind, err)
	}
	return b.String(), nil
}

func renderText(kind string, t *texttemplate.Template, d Data) (string, error) {
	if t == nil {
		return execText(kind+".txt", d)
	}
	var b strings.Builder
	if err := t.Execute(&b, d); err != nil {
		return "", fmt.Errorf("mail: 渲染 %s:text: %w", kind, err)
	}
	return b.String(), nil
}

func renderBody(kind string, t *htmltemplate.Template, d Data) (string, error) {
	if t == nil {
		return execHTML(kind+"_body.html", d)
	}
	var b strings.Builder
	if err := t.Execute(&b, d); err != nil {
		return "", fmt.Errorf("mail: 渲染 %s:html: %w", kind, err)
	}
	return b.String(), nil
}

// Builtin 返回内置模板的三段源（管理端把编辑框先填成现状用）。
// 源编回去再渲染与 Render 产物逐字一致 —— 这条由 compiled_test.go 的 TestBuiltinSourcesRoundTrip 钉住。
func Builtin(kind string) (Override, error) {
	if _, ok := subjectOf[kind]; !ok {
		return Override{}, fmt.Errorf("mail: 不认识的模板 %q", kind)
	}
	ov := Override{Subject: subjectOf[kind]}
	var err error
	if ov.HTMLBody, err = readTemplate("templates/" + kind + "_body.html"); err != nil {
		return Override{}, err
	}
	if ov.TextBody, err = readTemplate("templates/" + kind + ".txt"); err != nil {
		return Override{}, err
	}
	return ov, nil
}

func readTemplate(name string) (string, error) {
	b, err := Templates.ReadFile(name)
	if err != nil {
		return "", fmt.Errorf("mail: 读内置模板 %s: %w", name, err)
	}
	return string(b), nil
}
