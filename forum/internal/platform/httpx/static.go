package httpx

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// 带这些扩展名的路径按「资源」处理：缺了就 404，绝不回退成 index.html。
// 回退成 HTML 会让 <img> 拿到解不出的内容，表现为裂图并掩盖真正原因（踩过）。
var assetExt = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".map": true, ".json": true, ".txt": true, ".xml": true,
	".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true, ".svg": true, ".ico": true,
	".woff": true, ".woff2": true, ".ttf": true, ".mp4": true, ".webm": true,
}

func looksLikeAsset(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return ext != "" && assetExt[ext]
}

// cacheFor 是带宽优化：带内容哈希的产物永久缓存，美术资源一周，其余一小时。
// 不设缓存头 = 每次进页面重下全部图片与 JS，在窄带宽上就是「图裂」和「慢」。
func cacheFor(p string) string {
	switch {
	case strings.HasPrefix(p, "/assets/") || strings.HasPrefix(p, "/devroom/assets/"):
		return "public, max-age=31536000, immutable"
	case strings.HasPrefix(p, "/art/") || strings.Contains(p, "/art/") || strings.Contains(p, "/img/"):
		return "public, max-age=604800"
	default:
		return "public, max-age=3600"
	}
}

// Static 挂上静态托管与 SPA 回退。
//
//	assets=true  时连 /assets/ 也由 Go 提供（开发期没有 nginx）；生产交给 nginx 直托管。
//	shell 是 HTML 壳：所有「不像资源」的路径都返回它，由前端路由接管。
//
// 三条行为都是踩过的坑，不是猜测：
//  1. 带扩展名且文件不存在 → 404，不回退 index.html；
//  2. 目录里有 index.html 就交给静态文件服务（/devroom/ 是子应用）；
//  3. 缓存头分级，index.html 本身 no-store。
func Static(root string, assets bool, shell func(c *gin.Context)) (gin.HandlerFunc, error) {
	indexPath := filepath.Join(root, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.Dir(root))

	return func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(http.StatusMethodNotAllowed)
			return
		}
		if !assets && strings.HasPrefix(c.Request.URL.Path, "/assets/") {
			c.Status(http.StatusNotFound)
			return
		}
		clean := filepath.Join(root, filepath.Clean("/"+strings.TrimPrefix(c.Request.URL.Path, "/")))
		// 根路径的 index.html 必须走**壳**（壳负责注入运行期前缀 / 或 /dev/）。
		// 2026-10-13：这里原来把根目录也当成「目录里有 index.html」直接发文件，于是 dist 里那份
		// 硬编码 <base href="/" /> 被原样发给浏览器 —— 配置生效了也没用，浏览器认的是文档里那个 base。
		// 子应用目录（/devroom/）保持原样：它自带自己的相对路径。
		atRoot := clean == root
		if info, err := os.Stat(clean); err == nil {
			if !info.IsDir() {
				// /index.html 也要走壳：它就是那份带占位 base 的文档
				if clean == indexPath {
					shell(c)
					return
				}
				c.Header("Cache-Control", cacheFor(c.Request.URL.Path))
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
			if idx, ierr := os.Stat(filepath.Join(clean, "index.html")); ierr == nil && !idx.IsDir() {
				if atRoot {
					shell(c)
					return
				}
				c.Header("Cache-Control", "no-store")
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
		}
		if looksLikeAsset(c.Request.URL.Path) {
			c.Status(http.StatusNotFound)
			return
		}
		shell(c)
	}, nil
}
