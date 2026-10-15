package mail_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/mail"
)

// TestAdminAccountCreateAndRotateOverHTTP 钉住**后台那两块表单**真正依赖的契约（D26）：
//
//	① POST /admin/mail/accounts 带 secret → 201，回执里 secret_configured=true；
//	② 回执 JSON 里**不出现 secret 子串**（凭据只写不回读，d6 §6.10 —— 前端就是靠这一点显示「已配置」）；
//	③ PATCH 同一个 id 带新 secret → 200 且 secret_updated_at 变新（「换凭据」那颗按钮打的就是它）。
//
// 为什么这条只能在 HTTP 层：前端读的是**响应体的字段名**（secret_configured / secret_updated_at / id），
// service 层用例断言不到「字段名写错了」——那正是本仓库最高频的事故（交接单 §5.1）。
func TestAdminAccountCreateAndRotateOverHTTP(t *testing.T) {
	h := newHarness(t)

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mw := func(...string) gin.HandlerFunc { return noop }
	login := func() gin.HandlerFunc { return noop }
	mail.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) {
		return h.adminActor(), true
	}).Register(engine.Group("/api/v1"), login, mw)

	create := `{"name":"ui-resend","provider":"resend","from_address":"noreply@example.com","from_name":"SC2clud",` +
		`"daily_limit":50,"priority":3,"secret":{"api_key":"re_test_key"}}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mail/accounts", strings.NewReader(create))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("建账号必须 201，实际 %d：%s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"secret"`) {
		t.Fatalf("回执里出现了 secret 字段（凭据只写不回读）：%s", w.Body.String())
	}
	var created struct {
		Data struct {
			ID               string `json:"id"`
			SecretConfigured bool   `json:"secret_configured"`
			SecretUpdatedAt  string `json:"secret_updated_at"`
			DailyLimit       int    `json:"daily_limit"`
			Priority         int    `json:"priority"`
			Enabled          bool   `json:"enabled"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("回执不是预期形状: %v：%s", err, w.Body.String())
	}
	if created.Data.ID == "" || !created.Data.SecretConfigured || created.Data.SecretUpdatedAt == "" {
		t.Fatalf("回执字段不对（前端读 id / secret_configured / secret_updated_at）：%s", w.Body.String())
	}
	if created.Data.DailyLimit != 50 || created.Data.Priority != 3 || !created.Data.Enabled {
		t.Fatalf("入参没有落库：%s", w.Body.String())
	}

	h.clk.T = h.clk.T.Add(2 * time.Hour) // 假时钟不前进，换凭据的「更新时间变新」看不出来（交接单 §5.5）
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mail/accounts/"+created.Data.ID,
		strings.NewReader(`{"secret":{"api_key":"re_rotated"}}`))
	req2.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("换凭据必须 200，实际 %d：%s", w2.Code, w2.Body.String())
	}
	var rotated struct {
		Data struct {
			SecretUpdatedAt string `json:"secret_updated_at"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &rotated); err != nil {
		t.Fatal(err)
	}
	if rotated.Data.SecretUpdatedAt == created.Data.SecretUpdatedAt {
		t.Fatalf("换凭据之后 secret_updated_at 必须变新：%q → %q", created.Data.SecretUpdatedAt, rotated.Data.SecretUpdatedAt)
	}
}
