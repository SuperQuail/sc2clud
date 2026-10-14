package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"

	"forum/internal/platform/apperr"
	"forum/internal/platform/idgen"
)

// Bind 解析并校验请求体。失败时返回 *apperr.Error（handler 交给 httpx.Fail）。
func Bind(c *gin.Context, dst any) error {
	if err := c.ShouldBindJSON(dst); err != nil {
		return bindError(dst, err)
	}
	return nil
}

// BindQuery 解析并校验查询串（列表接口的 limit/cursor/sort 用）。
func BindQuery(c *gin.Context, dst any) error {
	if err := c.ShouldBindQuery(dst); err != nil {
		return bindError(dst, err)
	}
	return nil
}

// ValidPathIDs 是路径参数里的对外 ID（uuid）的唯一一道闸，挂在**路由器组**上：
//
//	rg = rg.Group("", httpx.ValidPathIDs("id", "sid"))
//
// 为什么必须在进 handler 之前挡下：这些参数最终会进 SQL 的 uuid 比较
// （pgsql 的 "WHERE public_id = $1"），非 uuid 会得到 PostgreSQL 22P02，
// 而它到不了任何一层业务错误映射 —— 冒到 HTTP 就是 500 common.internal。
// 2026-10-14 实测：POST /admin/topics/not-a-uuid/review 与 PATCH /topics/not-a-uuid 都是 500。
//
// 放在组上而不是每个 handler 里：这是一条**格式**规则（对外 ID 一律 uuid），
// 每条新路由都记得写一遍的规则等于没有规则。值域与非 uuid 的取舍见各 service（404 由它出）。
// 只校验点名的参数：:slug / :handle 不是 ID。
func ValidPathIDs(names ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		for _, name := range names {
			v := c.Param(name)
			if v == "" {
				continue // 路由里没有这个参数（gin 对不同方法共用同一棵前缀树）
			}
			if _, err := idgen.ParsePublicID(v); err != nil {
				Fail(c, apperr.Invalid(map[string]string{name: "格式不正确"}))
				return
			}
		}
		c.Next()
	}
}

func bindError(dst any, err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return apperr.ErrTooLarge
	}

	var verrs validator.ValidationErrors
	if errors.As(err, &verrs) {
		return apperr.Invalid(fieldErrors(dst, verrs))
	}

	// 请求体不是合法 JSON / 类型对不上：拿不到字段级信息，给一句整体提示
	var syn *json.SyntaxError
	var ute *json.UnmarshalTypeError
	if errors.As(err, &syn) || errors.As(err, &ute) {
		return apperr.Invalid(map[string]string{"_": "请求体格式不正确"})
	}
	return apperr.Invalid(map[string]string{"_": "参数错误"})
}

// fieldErrors 把 validator 的字段名换成 JSON 名，并翻译成人话。
func fieldErrors(dst any, verrs validator.ValidationErrors) map[string]string {
	names := jsonNames(reflect.TypeOf(dst))
	out := make(map[string]string, len(verrs))
	for _, fe := range verrs {
		key := names[fe.StructField()]
		if key == "" || key == "-" {
			key = "_"
		}
		if _, dup := out[key]; dup {
			continue // 同一字段多条错误只留第一条
		}
		out[key] = message(fe)
	}
	if len(out) == 0 {
		out["_"] = "参数错误"
	}
	return out
}

// jsonNames 建一张 Go 字段名 → JSON 字段名的表。json tag 就是契约（v2 §21.5）。
func jsonNames(t reflect.Type) map[string]string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	out := make(map[string]string, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		out[f.Name] = strings.Split(f.Tag.Get("json"), ",")[0]
	}
	return out
}

// 中文文案只在这一张表里；表外的 tag 退回一句通用话。
func message(fe validator.FieldError) string {
	switch fe.Tag() {
	case "required":
		return "不能为空"
	case "email":
		return "邮箱格式不正确"
	case "url":
		return "必须是合法链接"
	case "uuid":
		return "格式不正确"
	case "min", "gte":
		return fmt.Sprintf("不能小于 %s", fe.Param())
	case "max", "lte":
		return fmt.Sprintf("不能大于 %s", fe.Param())
	case "len":
		return fmt.Sprintf("长度必须是 %s", fe.Param())
	case "oneof":
		return fmt.Sprintf("只能是 %s 之一", strings.ReplaceAll(fe.Param(), " ", "/"))
	case "gt":
		return fmt.Sprintf("必须大于 %s", fe.Param())
	case "lt":
		return fmt.Sprintf("必须小于 %s", fe.Param())
	case "alphanum":
		return "只能包含字母和数字"
	default:
		return "参数不合法"
	}
}
