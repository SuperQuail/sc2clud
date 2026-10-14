package auth

// 自检面板的用例（交接单 C3）。**先确认会红**：路由不存在时是 404。

import (
	"encoding/json"
	"testing"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

func checkOf(t *testing.T, d *DiagnosticsDTO, name string) DiagnosticCheckDTO {
	t.Helper()
	for _, c := range d.Checks {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("没有检查项 %s", name)
	return DiagnosticCheckDTO{}
}

// diagFixtures 种 root（超管）与 plain（普通用户）。返回两个令牌。
func diagFixtures(t *testing.T, f *fixture) (string, string) {
	t.Helper()
	f.seedRBAC()
	f.newUser("root", "pw-root-11", "superadmin")
	f.newUser("plain", "pw-plain-11", "user")
	return f.login("root", "pw-root-11"), f.login("plain", "pw-plain-11")
}

// 门控的第一层：权限点 site.setting。游客 401、普通用户 403。
func TestAdminDiagnosticsNeedsSiteSetting(t *testing.T) {
	f := newFixture(t)
	_, plainTok := diagFixtures(t, f)
	r := f.newAdminRouter()

	if w := f.doJSON(r, "GET", "/api/v1/admin/diagnostics", "", ""); w.Code != 401 {
		t.Fatalf("游客必须是 401，实际 %d：%s", w.Code, w.Body.String())
	}
	w := f.doJSON(r, "GET", "/api/v1/admin/diagnostics", plainTok, "")
	if w.Code != 403 {
		t.Fatalf("没有 site.setting 必须是 403，实际 %d：%s", w.Code, w.Body.String())
	}
	if code := errCodeOfBody(t, w.Body.Bytes()); code != apperr.CodeForbidden {
		t.Fatalf("错误码应当是 %s，实际 %s", apperr.CodeForbidden, code)
	}
}

// 门控的第二层：debug 关闭 → **404 common.not_found**，不是空 200（§5.13）。
// 这条是 C3 的全部要点：空 200 会让「生产上关掉了」与「跑了但没结果」长得一样。
func TestAdminDiagnosticsDebugOffIs404(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := diagFixtures(t, f)
	f.svc.cfg.HTTP.Debug = false
	r := f.newAdminRouter()

	w := f.doJSON(r, "GET", "/api/v1/admin/diagnostics", rootTok, "")
	if w.Code == 200 {
		t.Fatalf("debug 关闭时**不许**回 200（正是 §5.13 要修的那个假绿）：%s", w.Body.String())
	}
	if w.Code != 404 {
		t.Fatalf("debug 关闭时必须是 404，实际 %d：%s", w.Code, w.Body.String())
	}
	if code := errCodeOfBody(t, w.Body.Bytes()); code != apperr.CodeNotFound {
		t.Fatalf("错误码应当是 %s，实际 %s", apperr.CodeNotFound, code)
	}
}

// service 层的同一条门控（不经 HTTP）：debug 关闭时错误码一致。
func TestAdminDiagnosticsServiceGate(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := diagFixtures(t, f)
	root := f.actor(rootTok)
	f.svc.cfg.HTTP.Debug = false

	_, err := f.svc.AdminDiagnostics(f.ctx, root)
	if err == nil {
		t.Fatal("debug 关闭时 service 也必须拒绝")
	}
	ae, ok := err.(*apperr.Error)
	if !ok || ae.Code != apperr.CodeNotFound {
		t.Fatalf("错误码应当是 %s，实际 %v", apperr.CodeNotFound, err)
	}
}

// debug 打开 + 超管：200 且形状完整，每条检查都带 status 与 ok 两个投影。
func TestAdminDiagnosticsOpen(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := diagFixtures(t, f)
	f.svc.cfg.HTTP.Debug = true
	f.svc.diag = DiagnosticsInfo{Version: "test-1c4a9f2", StartedAt: f.clk.Now(), Readonly: true}
	r := f.newAdminRouter()

	w := f.doJSON(r, "GET", "/api/v1/admin/diagnostics", rootTok, "")
	if w.Code != 200 {
		t.Fatalf("debug 打开时应当 200，实际 %d：%s", w.Code, w.Body.String())
	}
	var env struct {
		Data DiagnosticsDTO `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应不是 {data:...}：%s", w.Body.String())
	}
	d := env.Data
	if !d.DebugEnabled || d.Version != "test-1c4a9f2" || d.StartedAt == nil || !d.Readonly {
		t.Fatalf("进程级事实不对: %+v", d)
	}
	if d.Total != 4 || len(d.Checks) != 4 {
		t.Fatalf("应当有 4 条检查，实际 total=%d len=%d", d.Total, len(d.Checks))
	}
	// 逐条检查：名字是契约（设计稿直接用它们当行标题），status 与 ok 必须一致
	names := map[string]bool{}
	for _, c := range d.Checks {
		names[c.Name] = true
		if c.Status != DiagOK && c.Status != DiagFail && c.Status != DiagSkipped {
			t.Fatalf("%s 的 status 不在值域里: %q", c.Name, c.Status)
		}
		if (c.Status == DiagOK) != c.Ok {
			t.Fatalf("%s 的 status=%q 与 ok=%v 不一致（两个投影说两句话）", c.Name, c.Status, c.Ok)
		}
		if c.Status == DiagFail && c.Detail == "" {
			t.Fatalf("%s 红了却没有 detail：面板上只有一行红，说不出原因", c.Name)
		}
		if c.MS < 0 {
			t.Fatalf("%s 的耗时是负的", c.Name)
		}
	}
	for _, want := range []string{"权限点集合一致性", "枚举值域与代码常量", "数据库迁移版本", "外键索引完备"} {
		if !names[want] {
			t.Fatalf("少了检查项 %s", want)
		}
	}
	// failed 与逐条对得上（前端要拿它做汇总，数错了会显示「全部通过」）
	failed := 0
	for _, c := range d.Checks {
		if c.Status == DiagFail {
			failed++
		}
	}
	if d.Failed != failed {
		t.Fatalf("failed=%d 与逐条数出来的 %d 不一致", d.Failed, failed)
	}
}

// 「没注入构建信息」时只跳过版本那一条，其余照跑（面板不该因为部署没配而整体不可用）。
func TestAdminDiagnosticsWithoutBuildInfoSkipsVersion(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := diagFixtures(t, f)
	f.svc.cfg.HTTP.Debug = true
	f.svc.diag = DiagnosticsInfo{} // 空：没有版本
	root := f.actor(rootTok)

	d, err := f.svc.AdminDiagnostics(f.ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if d.StartedAt != nil {
		t.Fatalf("没注入启动时间时应当是 null，实际 %v", d.StartedAt)
	}
	if d.Version != "" {
		t.Fatalf("没注入版本时应当是空串，实际 %q", d.Version)
	}
	for _, c := range d.Checks {
		if c.Name == "数据库迁移版本" && c.Status == DiagFail {
			t.Fatalf("没注入版本时这条不该报红（报红只会训练人忽略它）: %s", c.Detail)
		}
	}
}

// 权限点检查在「表里缺权限点」时要真的报出来（否则这一行是永远通过的检查）。
func TestAdminDiagnosticsPermissionCheckGoesRed(t *testing.T) {
	f := newFixture(t)
	diagFixtures(t, f)
	f.svc.cfg.HTTP.Debug = true
	root := f.actor(f.login("root", "pw-root-11"))

	// 先证明删之前它是**绿**的：不先绿一次，红可能是别的原因（这条检查本来就不成立）。
	before, err := f.svc.AdminDiagnostics(f.ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if !checkOf(t, before, "权限点集合一致性").Ok {
		t.Fatalf("删权限点之前这条应当是绿的，实际 %+v", checkOf(t, before, "权限点集合一致性"))
	}

	if _, err := f.pool.Exec(f.ctx, "DELETE FROM permissions WHERE key = $1", authz.PermBoardManage); err != nil {
		t.Fatal(err)
	}
	d, err := f.svc.AdminDiagnostics(f.ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, c := range d.Checks {
		if c.Name != "权限点集合一致性" {
			continue
		}
		found = true
		if c.Status != DiagFail || c.Ok {
			t.Fatalf("删掉一个权限点后这条必须报红，实际 %+v", c)
		}
	}
	if !found {
		t.Fatal("没找到权限点检查这一条")
	}
	if d.Failed == 0 {
		t.Fatal("汇总的 failed 也必须反映它")
	}
}
