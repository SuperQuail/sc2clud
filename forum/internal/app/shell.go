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
var baseTagRe = regexp.MustCompile(`(?i)<base\s+href="[^"]*"\s*/?>`)

// 注意上面那两个 \s 的反斜杠。写成 s+ / s* 时正则永远匹配不到，Render 会走「插入」分支，
// 页面上就留下**两个** <base>：先插的那个在前（浏览器恰好用对的），原来那个仍在文中。
// 2026-10-13：把 dev 切到 /dev/ 时发现的 —— 症状是「配置明明生效了，页面却仍加载根路径的资源」。

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
