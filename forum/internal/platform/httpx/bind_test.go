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

// 路径参数闸：非 uuid 的 {id} 必须在 handler 之前变成 400，而不是让它进 SQL
// （PostgreSQL 22P02 → 500）。旧行为下这条用例红：handler 会收到 "not-a-uuid"。
func TestValidPathIDsRejectsNonUUID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestIDMiddleware(testLogger()))
	// 与真实挂法一致：闸挂在一组上，handler 只负责回 200。
	rg := r.Group("/api/v1", ValidPathIDs("id", "sid"))
	reached := ""
	rg.GET("/topics/:id", func(c *gin.Context) { reached = c.Param("id"); OK(c, gin.H{"id": c.Param("id")}) })
	rg.GET("/topics/:id/sources/:sid/go", func(c *gin.Context) { reached = c.Param("sid"); OK(c, gin.H{"sid": c.Param("sid")}) })

	for _, tc := range []struct{ name, path string }{
		{"判定路由的 id", "/api/v1/topics/not-a-uuid"},
		{"第二个参数 sid", "/api/v1/topics/00000000-0000-7000-8000-000000000000/sources/nope/go"},
	} {
		reached = ""
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s：状态码 %d, want 400: %s", tc.name, w.Code, w.Body.String())
		}
		if reached != "" {
			t.Fatalf("%s：闸放行了非 uuid，handler 被调用了", tc.name)
		}
		errObj := decode(t, w)["error"].(map[string]any)
		if errObj["code"] != apperr.CodeInvalidInput {
			t.Fatalf("%s：code=%v", tc.name, errObj["code"])
		}
	}

	// 合法 uuid 照常进 handler（闸不能把好路径也挡了）
	id := "018f0e60-0000-7000-8000-000000000001"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/topics/"+id, nil))
	if w.Code != http.StatusOK || reached != id {
		t.Fatalf("合法 uuid 应当进 handler：%d %s", w.Code, w.Body.String())
	}
}
