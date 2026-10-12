// forum 是 SC2clud 的服务端：目前只做「提供前端产物 + 健康检查」。
// 业务接口按 完全重构/论坛后端技术方案-v2.md 逐步加，先让部署链路跑通。
package main

import (
	"encoding/json"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 由 -ldflags -X main.version=... 注入（部署脚本传 git short sha）
var version = "dev"

func main() {
	addr := flag.String("addr", "127.0.0.1:8081", "监听地址")
	web := flag.String("web", "./dist", "前端产物目录")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	index := filepath.Join(*web, "index.html")
	raw, err := os.ReadFile(index)
	if err != nil {
		logger.Error("找不到前端产物，先跑 web 的 build", "path", index)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("cache-control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": version})
	})

	files := http.FileServer(http.Dir(*web))
	serveIndex := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		_, _ = w.Write(raw)
	}
	mux.Handle("/", spa(*web, files, serveIndex))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           accessLog(logger, mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	logger.Info("forum 启动", "addr", *addr, "web", *web, "version", version)
	if err := srv.ListenAndServe(); err != nil {
		logger.Error("退出", "err", err)
		os.Exit(1)
	}
}

// assetExt：带这些扩展名的路径按「资源」处理——缺了就 404，绝不回退成 index.html。
// 回退成 HTML 会让 <img> 拿到解不出的内容，表现为「裂图」并掩盖真正原因（踩过）。
var assetExt = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".map": true, ".json": true, ".txt": true, ".xml": true,
	".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true, ".svg": true, ".ico": true,
	".woff": true, ".woff2": true, ".ttf": true, ".mp4": true, ".webm": true,
}

func looksLikeAsset(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext != "" && assetExt[ext]
}

// cacheFor：带宽优化。带内容哈希的产物可以永久缓存；美术资源缓存一周；其余短缓存。
// 不设缓存头 = 每次进页面都重下全部图片与 JS，在窄带宽上就是「图裂」和「慢」。
func cacheFor(path string) string {
	switch {
	case strings.HasPrefix(path, "/assets/") || strings.HasPrefix(path, "/devroom/assets/"):
		// Vite 产物名里带哈希，内容变了文件名就变，可以放心永久缓存
		return "public, max-age=31536000, immutable"
	case strings.HasPrefix(path, "/art/") || strings.Contains(path, "/art/") || strings.Contains(path, "/img/"):
		return "public, max-age=604800"
	default:
		return "public, max-age=3600"
	}
}

// spa：命中静态文件就发文件（并加缓存头）；带扩展名的缺失资源直接 404；其余交给 index.html。
func spa(root string, files http.Handler, serveIndex http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		clean := filepath.Join(root, filepath.Clean("/"+strings.TrimPrefix(r.URL.Path, "/")))
		if info, err := os.Stat(clean); err == nil {
			if !info.IsDir() {
				w.Header().Set("cache-control", cacheFor(r.URL.Path))
				files.ServeHTTP(w, r)
				return
			}
			// 目录：有 index.html 就是子应用（/devroom/），交给静态服务器；否则走前端路由
			if idx, ierr := os.Stat(filepath.Join(clean, "index.html")); ierr == nil && !idx.IsDir() {
				w.Header().Set("cache-control", "no-store")
				files.ServeHTTP(w, r)
				return
			}
		}
		if looksLikeAsset(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r)
	})
}

func accessLog(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if r.URL.Path != "/healthz" {
			logger.Info("req", "m", r.Method, "path", r.URL.Path, "ms", time.Since(start).Milliseconds())
		}
	})
}
