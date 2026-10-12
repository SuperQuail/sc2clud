package app

import (
	"fmt"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// Shell 是 HTML 文档壳：读构建产物里的 index.html，按实例注入运行期前缀。
// 它只填 <head>，body 结构与数据 100% 由 React 渲染（前端方案 §2.4）。
type Shell struct {
	raw  string
	base string // 运行期前缀，例如 "/" 或 "/dev/"
}

// NewShell 在启动时读一次并校验存在：把「前端产物没上传」从运行期 404 变成启动失败。
func NewShell(distDir, base string) (*Shell, error) {
	raw, err := os.ReadFile(filepath.Join(distDir, "index.html"))
	if err != nil {
		return nil, fmt.Errorf("读前端产物失败（先构建 web/dist）: %w", err)
	}
	if base == "" {
		base = "/"
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return &Shell{raw: string(raw), base: base}, nil
}

// baseTagRe 匹配 index.html 里那个占位 <base href="/" />。
var baseTagRe = regexp.MustCompile(`(?i)<bases+href="[^"]*"s*/?>`)

// Render 返回注入前缀后的 HTML。
// 找不到 <base> 标签时插入一个——静默返回错的资源前缀，在 dev 上表现为加载了生产的产物。
func (s *Shell) Render() string {
	tag := `<base href="` + html.EscapeString(s.base) + `" />`
	if baseTagRe.MatchString(s.raw) {
		return baseTagRe.ReplaceAllString(s.raw, tag)
	}
	if i := strings.Index(strings.ToLower(s.raw), "<head>"); i >= 0 {
		return s.raw[:i+6] + "\n    " + tag + s.raw[i+6:]
	}
	return tag + s.raw
}

// Handler 挂上壳的路由处理。
func (s *Shell) Handler() gin.HandlerFunc {
	body := s.Render()
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Data(200, "text/html; charset=utf-8", []byte(body))
	}
}
