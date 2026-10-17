package mail

import (
	"embed"
	"fmt"
	htmltemplate "html/template"
	"strings"
	texttemplate "text/template"
)

// Templates 是嵌入的邮件模板：每个模板同时给 HTML 骨架、HTML 正文片段、纯文本正文。
//
// 文件名就是模板名（ParseFS 的规则），所以模板之间**不共用任何模板名**：
// 早期版本用 {{block "title"}}/{{block "body"}} 做可选覆盖，而 block 定义的是**全局**模板名，
// 于是渲染 notice 时会套上 verify_email 的标题与正文（两个类型共用一个名字，互相覆盖）。
//
//go:embed templates/*.html templates/*.txt
var Templates embed.FS

// htmlTpl / textTpl 在进程启动时解析一次：模板写错是部署时就能红的事，
// 不该等到某个用户触发那封信才炸。
var (
	htmlTpl = htmltemplate.Must(htmltemplate.ParseFS(Templates, "templates/*.html"))
	textTpl = texttemplate.Must(texttemplate.ParseFS(Templates, "templates/*.txt"))
)

// subjectOf 是四个模板的主题。
//
// 主题放 Go 里是因为它是一句话：为它各建一个文件会让模板目录一半文件只有一行。
// 主题里也不放验证码——收件箱列表里显示验证码反而是泄露。
var subjectOf = map[string]string{
	"verify_email":   "邮箱验证码",
	"reset_password": "重置密码验证码",
	"test":           "发信测试",
	"notice":         "站内通知",
}

// Data 是模板能看到的全部字段。模板只接收结构体，禁止拼接用户输入的 HTML（v2 §8.5）。
type Data struct {
	SiteName  string // 站名，空则用默认值
	Nickname  string // 收件人昵称，可空
	Code      string // 验证码
	ExpiresIn string // 有效期的人类可读形式，如 "10 分钟"
	Title     string // notice 的标题（进 <title> 与主题）
	Body      string // notice 的正文（纯文本，模板会转义）
	Link      string // notice 的跳转地址
	From      string // test 用：发件人
	Now       string // test 用：当前时间（调用方格式化，模板不调 time.Now）
}

// layoutData 是骨架模板的数据：Title 是 <title>，Body 是已渲染好的正文片段。
// 两个都是 template.HTML——它们是我们自己渲染的模板输出，不是用户输入，
// 不该被二次转义（用户输入在渲染片段时已经按上下文转义过了）。
type layoutData struct {
	SiteName string
	Title    string
	Body     htmltemplate.HTML
}

// Render 渲染一个模板，返回可直接交给 Provider 的 Message（To 由调用方填）。
//
// kind 与 mail_logs.template 的 CHECK 逐字一致：verify_email / reset_password / test / notice。
// 缺必需字段（验证码类没有 Code、notice 没有 Title）返回错误——那是**调用方的代码 bug**，
// 调用方据此把这条投递置 failed 且不重试（d6 §6.11）。
func Render(kind string, d Data) (Message, error) {
	subject, d, err := prepare(kind, d)
	if err != nil {
		return Message{}, err
	}
	text, err := execText(kind+".txt", d)
	if err != nil {
		return Message{}, err
	}
	body, err := execHTML(kind+"_body.html", d)
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

// prepare 是内置与自定义两条渲染路径共用的校验与兜底（必须同源，避免两处各默认一次）：
// 返回值是「内置主题 + 兜完底的数据」。缺必需字段返回错误 —— 那是调用方的代码 bug。
func prepare(kind string, d Data) (string, Data, error) {
	subject, ok := subjectOf[kind]
	if !ok {
		return "", d, fmt.Errorf("mail: 不认识的模板 %q", kind)
	}
	if d.SiteName == "" {
		d.SiteName = "论坛"
	}
	switch kind {
	case "verify_email", "reset_password":
		if d.Code == "" {
			return "", d, fmt.Errorf("mail: 模板 %s 缺 Code", kind)
		}
		if d.ExpiresIn == "" {
			d.ExpiresIn = "10 分钟"
		}
	case "notice":
		if d.Title == "" {
			return "", d, fmt.Errorf("mail: 模板 notice 缺 Title")
		}
	}
	return subject, d, nil
}

// execHTML 渲染 HTML：html/template 按上下文转义，昵称与正文里的 < > 都变成实体。
func execHTML(name string, d any) (string, error) {
	var b strings.Builder
	if err := htmlTpl.ExecuteTemplate(&b, name, d); err != nil {
		return "", fmt.Errorf("mail: 渲染模板 %s: %w", name, err)
	}
	return b.String(), nil
}

// execText 渲染纯文本。
func execText(name string, d Data) (string, error) {
	var b strings.Builder
	if err := textTpl.ExecuteTemplate(&b, name, d); err != nil {
		return "", fmt.Errorf("mail: 渲染模板 %s: %w", name, err)
	}
	return b.String(), nil
}
