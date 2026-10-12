package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/apperr"
)

// 测试里不要输出日志（会淹没测试输出）
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func testEngine(h gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestIDMiddleware(testLogger()))
	r.GET("/t", h)
	return r
}

func doGet(t *testing.T, r *gin.Engine) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/t", nil)
	r.ServeHTTP(w, req)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, w.Body.String())
	}
	return m
}

func TestFailMapsAppErr(t *testing.T) {
	w := doGet(t, testEngine(func(c *gin.Context) { Fail(c, apperr.ErrConflict) }))
	if w.Code != 409 {
		t.Fatalf("状态码 %d, want 409", w.Code)
	}
	errObj, ok := decode(t, w)["error"].(map[string]any)
	if !ok {
		t.Fatalf("没有 error 包络: %s", w.Body.String())
	}
	if errObj["code"] != apperr.CodeConflict {
		t.Fatalf("code=%v", errObj["code"])
	}
	if rid, _ := errObj["request_id"].(string); rid == "" {
		t.Fatalf("没有 request_id: %v", errObj)
	}
}

func TestFailMapsInvalidFields(t *testing.T) {
	w := doGet(t, testEngine(func(c *gin.Context) {
		Fail(c, apperr.Invalid(map[string]string{"title": "不能为空"}))
	}))
	if w.Code != 400 {
		t.Fatalf("状态码 %d, want 400", w.Code)
	}
	errObj := decode(t, w)["error"].(map[string]any)
	fields, ok := errObj["fields"].(map[string]any)
	if !ok || fields["title"] != "不能为空" {
		t.Fatalf("fields 没透出来: %v", errObj)
	}
}

func TestFailHidesInternalDetail(t *testing.T) {
	const secret = "pq: relation users does not exist"
	w := doGet(t, testEngine(func(c *gin.Context) { Fail(c, errors.New(secret)) }))
	if w.Code != 500 {
		t.Fatalf("状态码 %d, want 500", w.Code)
	}
	body := w.Body.String()
	if contains(body, secret) {
		t.Fatalf("内部错误信息泄漏到响应里: %s", body)
	}
	errObj := decode(t, w)["error"].(map[string]any)
	if errObj["code"] != apperr.CodeInternal {
		t.Fatalf("code=%v", errObj["code"])
	}
}

func TestFailContextCanceledIs499(t *testing.T) {
	w := doGet(t, testEngine(func(c *gin.Context) { Fail(c, context.Canceled) }))
	if w.Code != 499 {
		t.Fatalf("状态码 %d, want 499（客户端断开不是服务端故障）", w.Code)
	}
}

func TestOKListNilIsEmptyArrayAndNullCursor(t *testing.T) {
	w := doGet(t, testEngine(func(c *gin.Context) { OKList(c, nil, "") }))
	if w.Code != 200 {
		t.Fatalf("状态码 %d", w.Code)
	}
	body := decode(t, w)
	cur, ok := body["next_cursor"]
	if !ok {
		t.Fatalf("没有 next_cursor 字段: %s", w.Body.String())
	}
	if cur != nil {
		t.Fatalf("next_cursor 必须是 null: %v", cur)
	}
}

func TestRecoverReturns500(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestIDMiddleware(testLogger()))
	r.Use(Recover())
	r.GET("/t", func(c *gin.Context) { panic("boom") })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/t", nil))
	if w.Code != 500 {
		t.Fatalf("panic 必须变成 500，实际 %d", w.Code)
	}
	if contains(w.Body.String(), "boom") {
		t.Fatalf("panic 内容泄漏到响应: %s", w.Body.String())
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
