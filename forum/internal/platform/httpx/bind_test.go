package httpx

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/apperr"
)

type bindDTO struct {
	Title string `json:"title" binding:"required"`
	Body  string `json:"body_text" binding:"max=10"`
}

func doPost(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/t", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func bindEngine() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestIDMiddleware(testLogger()))
	r.POST("/t", func(c *gin.Context) {
		var in bindDTO
		if err := Bind(c, &in); err != nil {
			Fail(c, err)
			return
		}
		OK(c, in)
	})
	return r
}

func TestBindErrorUsesJSONFieldNames(t *testing.T) {
	w := doPost(t, bindEngine(), `{"body_text":"way too long for the limit"}`)
	if w.Code != 400 {
		t.Fatalf("状态码 %d, want 400: %s", w.Code, w.Body.String())
	}
	fields := decode(t, w)["error"].(map[string]any)["fields"].(map[string]any)
	if _, leaked := fields["Title"]; leaked {
		t.Fatalf("fields 里出现了 Go 字段名 Title: %v", fields)
	}
	if _, leaked := fields["Body"]; leaked {
		t.Fatalf("fields 里出现了 Go 字段名 Body: %v", fields)
	}
	if fields["title"] != "不能为空" {
		t.Fatalf("title 的提示不对: %v", fields)
	}
	if fields["body_text"] == nil {
		t.Fatalf("body_text 的 max 错误没落到 fields: %v", fields)
	}
}

func TestBindBadJSON(t *testing.T) {
	w := doPost(t, bindEngine(), `{not json`)
	if w.Code != 400 {
		t.Fatalf("状态码 %d, want 400", w.Code)
	}
	errObj := decode(t, w)["error"].(map[string]any)
	if errObj["code"] != apperr.CodeInvalidInput {
		t.Fatalf("code=%v", errObj["code"])
	}
}

func TestBindErrorIsAppErr(t *testing.T) {
	var in bindDTO
	err := bindError(&in, errors.New("boom"))
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		t.Fatalf("bindError 必须返回 *apperr.Error，实际 %T", err)
	}
}
