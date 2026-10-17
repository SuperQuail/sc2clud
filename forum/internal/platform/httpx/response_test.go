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
	"github.com/jackc/pgx/v5/pgconn"

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

// D70：未识别的错误也要给出可判读的原因 —— 线上那次保存来源的 500，真正原因是 PG 23514，
// 用户只看到「（错误编号 …）」。归类成中文进 message，code / status 不动，原始细节只进日志。
func TestFailClassifiesSQLState(t *testing.T) {
	const detail = "new row for relation \"topic_sources\" violates check constraint \"ck_topic_sources_size\""
	cases := []struct{ code, reason string }{
		{"23505", "已有相同记录（唯一约束冲突）"},
		{"23503", "关联的数据不存在"},
		{"23514", "数据不满足字段约束"}, // D70 现场那一条
		{"23502", "必填字段为空"},
		{"22P02", "参数格式不正确"},
		{"40001", "并发冲突，请重试"},
		{"40P01", "并发冲突，请重试"},
		{"57014", "查询超时"},
		{"08006", "数据库连接不可用"}, // 08 类：服务端说连接异常
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			w := doGet(t, testEngine(func(c *gin.Context) {
				Fail(c, &pgconn.PgError{Code: tc.code, Message: detail, ConstraintName: "ck_topic_sources_size"})
			}))
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("状态码 %d, want 500（契约不动）", w.Code)
			}
			errObj, ok := decode(t, w)["error"].(map[string]any)
			if !ok {
				t.Fatalf("没有 error 包络: %s", w.Body.String())
			}
			if errObj["code"] != apperr.CodeInternal {
				t.Fatalf("code=%v, want %s（契约不动）", errObj["code"], apperr.CodeInternal)
			}
			if msg, _ := errObj["message"].(string); !contains(msg, tc.reason) {
				t.Fatalf("message=%q 不含原因 %q（只剩编号等于没给原因）", msg, tc.reason)
			}
			if contains(w.Body.String(), "ck_topic_sources_size") {
				t.Fatalf("原始细节泄漏到响应: %s", w.Body.String())
			}
		})
	}
}

// 认不出来的错误：笼统句 + 让人能对日志的提示，不能是空串（空串在前端就等于只剩编号）。
func TestFailUnknownInternalKeepsGenericMessage(t *testing.T) {
	w := doGet(t, testEngine(func(c *gin.Context) { Fail(c, errors.New("boom")) }))
	errObj := decode(t, w)["error"].(map[string]any)
	msg, _ := errObj["message"].(string)
	if msg == "" || !contains(msg, "服务器错误") || !contains(msg, "日志") {
		t.Fatalf("message=%q 既没笼统句也没「详见日志」", msg)
	}
}

// 数据库连不上：底层是 *net.OpError，别被 isClosedConn 当成「客户端提前断开」吞成 200 空响应。
func TestFailDBUnavailableIs500(t *testing.T) {
	// 127.0.0.1:1 不会有人监听，pgx 拨号失败给的就是真的 *pgconn.ConnectError。
	// （不能直接构造零值：它的 err 字段不导出，Error() 会空指针。）
	_, err := pgconn.Connect(context.Background(), "postgres://u@127.0.0.1:1/d?sslmode=disable&connect_timeout=2")
	if err == nil {
		t.Skip("本机 1 端口居然连得上")
	}
	w := doGet(t, testEngine(func(c *gin.Context) { Fail(c, err) }))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("状态码 %d, want 500（不能是 200 空响应）", w.Code)
	}
	msg, _ := decode(t, w)["error"].(map[string]any)["message"].(string)
	if !contains(msg, "数据库连接不可用") {
		t.Fatalf("message=%q 没说清是数据库连不上", msg)
	}
}

// 连接超时仍是 408：数据库那条分类不能抢在 DeadlineExceeded 前面。
func TestFailDeadlineExceededIs408(t *testing.T) {
	w := doGet(t, testEngine(func(c *gin.Context) { Fail(c, context.DeadlineExceeded) }))
	if w.Code != http.StatusRequestTimeout {
		t.Fatalf("状态码 %d, want 408", w.Code)
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
