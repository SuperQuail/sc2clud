package mail_test

import (
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/mail"
	pgmail "forum/internal/platform/mail"
)

// D37：邮件模板后台可编辑。这组用例钉四条契约：
//
//  1. 缺行回落内置（ListTemplates 的 custom=false + 内置源；投递语义零变化）；
//  2. 合法修改保存 → 预览与**真投递链**（HandleMailSend → Router → log provider）都换成新文案，
//     二次保存后第二次投递必须是新版（tasks.go 的进程内缓存失效真实生效）；
//  3. 预览按样本 Data 实渲染：样本昵称带 <script>，HTML 里必须是 &lt;script&gt;（转义证据）；
//  4. 「恢复内置」= DELETE：下一封信落回内置，删了再写再删来回切都成立（真重置默认）。
func (h *harness) tplActor() *authz.Actor {
	return &authz.Actor{UserID: h.userID, Perms: authz.NewSet(authz.PermSiteSetting), Status: "active"}
}

const customHTML = `<p>自定义正文 {{.Code}}，<b>{{.Nickname}}</b>，{{.ExpiresIn}}内有效</p>`
const customText = `自定义文本 {{.Code}} {{.Nickname}}`

func validInput() mail.TemplateInput {
	return mail.TemplateInput{Subject: "重置你的密码 {{.Code}}", HTMLBody: customHTML, TextBody: customText}
}

func TestTemplatesListFallsBackToBuiltin(t *testing.T) {
	h := newHarness(t)
	out, err := h.svc.ListTemplates(h.ctx, h.tplActor())
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 4 {
		t.Fatalf("四行，实际 %d：%+v", len(out), out)
	}
	seen := map[string]bool{}
	for _, v := range out {
		if seen[v.Kind] {
			t.Fatalf("kind 重复: %s", v.Kind)
		}
		seen[v.Kind] = true
		if v.Custom {
			t.Fatalf("%s: 没保存过不该是 custom", v.Kind)
		}
		if v.Subject == "" || v.HTMLBody == "" || v.TextBody == "" {
			t.Fatalf("%s: 内置源必须把编辑框填成现状（给管理员看）：%+v", v.Kind, v)
		}
		if v.UpdatedAt != nil {
			t.Fatalf("%s: 没保存过不该有 updated_at", v.Kind)
		}
	}
	if !seen[mail.TemplateVerifyEmail] || !seen[mail.TemplateResetPassword] || !seen[mail.TemplateTest] || !seen[mail.TemplateNotice] {
		t.Fatalf("四条 kind 缺了：%v", seen)
	}
	if out[0].Subject != "邮箱验证码" {
		t.Fatalf("缺行回落内置主题: %q", out[0].Subject)
	}
}

// 全链路：保存 → 预览是新文案 → 真投递链第一封是自定义 → 再保存 → 第二封是新版（缓存失效生效）。
func TestPutTemplateChangesPreviewAndDelivery(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.PutTemplate(h.ctx, h.tplActor(), mail.TemplateVerifyEmail, validInput(), ""); err != nil {
		t.Fatal(err)
	}
	in := validInput()
	pv, err := h.svc.PreviewTemplate(h.ctx, h.tplActor(), mail.TemplateVerifyEmail, &in)
	if err != nil {
		t.Fatal(err)
	}
	if pv.Subject != "重置你的密码 123456" {
		t.Fatalf("预览主题应插值样本码: %q", pv.Subject)
	}
	if !strings.Contains(pv.HTML, "自定义正文 123456") {
		t.Fatalf("预览 HTML 应是新正文: %s", pv.HTML)
	}
	if !strings.Contains(pv.HTML, "&lt;script&gt;alert(1)&lt;/script&gt;") || strings.Contains(pv.HTML, "<script>alert(1)</script>") {
		t.Fatalf("样本昵称在 HTML 里必须转义: %s", pv.HTML)
	}
	if !strings.Contains(pv.Text, "<script>alert(1)</script>") {
		t.Fatal("纯文本替身保留原样（纯文本没有转义概念）")
	}
	if !strings.Contains(pv.HTML, "测试站") {
		t.Fatalf("预览站名应来自站点设置: %s", pv.HTML)
	}
	// 真投递链第一封：自定义版
	h.newAccount("main", "log", 10, 5, `{"api_key":"k"}`, "")
	logID := h.enqueue(mail.EnqueueInput{
		RecipientID: 1, ToAddress: "u@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "111111"},
	})
	if err := h.svc.HandleMailSend(h.ctx, h.payload(logID)); err != nil {
		t.Fatal(err)
	}
	sent := h.sent()
	if len(sent) != 1 {
		t.Fatalf("投递了 %d 封，想要 1：%+v", len(sent), sent)
	}
	if sent[0].Subject != "重置你的密码 111111" || !strings.Contains(sent[0].HTML, "自定义正文 111111") {
		t.Fatalf("第一封没走自定义模板: %+v", sent[0])
	}
	// 再保存 → 缓存失效 → 第二封是更新的版本
	second := validInput()
	second.TextBody = `第二版文本 {{.Code}}`
	if _, err := h.svc.PutTemplate(h.ctx, h.tplActor(), mail.TemplateVerifyEmail, second, ""); err != nil {
		t.Fatal(err)
	}
	logID2 := h.enqueue(mail.EnqueueInput{
		RecipientID: 2, ToAddress: "v@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "222222"},
	})
	if err := h.svc.HandleMailSend(h.ctx, h.payload(logID2)); err != nil {
		t.Fatal(err)
	}
	sent = h.sent()
	if len(sent) != 2 {
		t.Fatalf("第二封投递后共 %d 封：%+v", len(sent), sent)
	}
	if !strings.Contains(sent[1].Text, "第二版文本 222222") {
		t.Fatalf("缓存失效没生效（第二封还是旧模板）: %+v", sent[1])
	}
	if sent[1].Subject != "重置你的密码 222222" {
		t.Fatalf("第二封主题不对: %q", sent[1].Subject)
	}
}

// 预览三种情形：**全内置**（转义证据来自内置正文）、部分覆盖（空段回落）、语法错（与保存同一道闸）。
func TestPreviewPartialAndInjection(t *testing.T) {
	h := newHarness(t)
	// ① 不带任何覆盖：三段全回落内置，样本昵称照样被内置的 html 正文转义、text 保留原文
	pv, err := h.svc.PreviewTemplate(h.ctx, h.tplActor(), mail.TemplateNotice, nil)
	if err != nil {
		t.Fatal(err)
	}
	if pv.Subject != "站内通知" {
		t.Fatalf("空覆盖 = 回落内置主题: %q", pv.Subject)
	}
	if strings.Contains(pv.HTML, "<script>alert(1)") || !strings.Contains(pv.HTML, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Fatalf("样本昵称必须被内置正文转义: %s", pv.HTML)
	}
	if !strings.Contains(pv.Text, "<script>alert(1)</script>") {
		t.Fatalf("内置 text 回落也要给原文（纯文本没有转义概念）: %s", pv.Text)
	}
	// ② 部分覆盖：只给 HTML —— subject/text 回落内置，正文换成编辑中那一段
	in := &mail.TemplateInput{HTMLBody: "<p>只有这一段 {{.Body}}</p>"}
	pv2, err := h.svc.PreviewTemplate(h.ctx, h.tplActor(), mail.TemplateNotice, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pv2.HTML, "只有这一段") {
		t.Fatalf("覆盖段没生效: %s", pv2.HTML)
	}
	if !strings.Contains(pv2.Text, "<script>alert(1)</script>") {
		t.Fatalf("没覆盖的段要回落内置: %s", pv2.Text)
	}
	// ③ 预览里的语法错同样当场拒收（管理员对着错误原话就能改）
	bad := "{{ .Code" // unclosed action：Parse 就红
	if _, err := h.svc.PreviewTemplate(h.ctx, h.tplActor(), mail.TemplateNotice, &mail.TemplateInput{HTMLBody: bad}); err == nil {
		t.Fatal("预览遇语法错必须报错（保存同闸）")
	}
}

// 「恢复内置」= DELETE：下一封信落回内置；删了（再多删一次）都幂等；再入表回到自定义。
func TestDeleteTemplateRestoresBuiltin(t *testing.T) {
	h := newHarness(t)
	h.newAccount("main", "log", 10, 50, `{"api_key":"k"}`, "")
	del := func() {
		t.Helper()
		if _, err := h.svc.DeleteTemplate(h.ctx, h.tplActor(), mail.TemplateResetPassword, ""); err != nil {
			t.Fatal(err)
		}
	}
	put := func(subject string) {
		t.Helper()
		in := mail.TemplateInput{Subject: subject + " {{.Code}}", HTMLBody: "<p>s</p>", TextBody: "t"}
		if _, err := h.svc.PutTemplate(h.ctx, h.tplActor(), mail.TemplateResetPassword, in, ""); err != nil {
			t.Fatal(err)
		}
	}
	deliver := func(code string) {
		t.Helper()
		id := h.enqueue(mail.EnqueueInput{RecipientID: 9, ToAddress: "z" + code + "@example.com", Template: mail.TemplateResetPassword, Data: pgmail.Data{Code: code}})
		if err := h.svc.HandleMailSend(h.ctx, h.payload(id)); err != nil {
			t.Fatal(err)
		}
	}
	subject := func(n int) string {
		t.Helper()
		return h.sent()[n].Subject
	}

	put("自定义重置")
	deliver("111111")
	if got := subject(0); got != "自定义重置 111111" {
		t.Fatalf("入表后该走自定义: %q", got)
	}

	del()
	deliver("222222")
	if got := subject(1); got != "重置密码验证码" {
		t.Fatalf("恢复内置后不该还是自定义: %q", got)
	}
	if got := h.sent()[1].Text; !strings.Contains(got, "你正在重置密码") {
		t.Fatalf("内置 text 没回来: %q", got)
	}

	del()
	del() // 重复恢复内置：幂等不报错
	put("再次自定义")
	deliver("333333")
	if got := subject(2); got != "再次自定义 333333" {
		t.Fatalf("再入表应当又是自定义: %q", got)
	}
	del()
	deliver("444444")
	if got := subject(3); got != "重置密码验证码" {
		t.Fatalf("第二次恢复后应是内置: %q", got)
	}
}

// 无权限与认不出的 kind：四条路 403 / 400。
func TestTemplatesPermsAndUnknownKind(t *testing.T) {
	h := newHarness(t)
	a := &authz.Actor{UserID: h.userID, Perms: authz.NewSet(authz.PermMailManage), Status: "active"}
	if _, err := h.svc.ListTemplates(h.ctx, a); err == nil {
		t.Error("ListTemplates 缺 site.setting 应 403")
	}
	if _, err := h.svc.PutTemplate(h.ctx, a, mail.TemplateNotice, mail.TemplateInput{Subject: "s", HTMLBody: "<p>x</p>", TextBody: "t"}, ""); err == nil {
		t.Error("PutTemplate 缺 site.setting 应 403")
	}
	if _, err := h.svc.DeleteTemplate(h.ctx, a, mail.TemplateNotice, ""); err == nil {
		t.Error("DeleteTemplate 缺 site.setting 应 403")
	}
	if _, err := h.svc.PreviewTemplate(h.ctx, a, mail.TemplateNotice, nil); err == nil {
		t.Error("PreviewTemplate 缺 site.setting 应 403")
	}
	if _, err := h.svc.PutTemplate(h.ctx, h.tplActor(), "nope", mail.TemplateInput{Subject: "s", HTMLBody: "<p>x</p>", TextBody: "t"}, ""); err == nil {
		t.Fatal("不认识的 kind 必须被挡")
	}
}
