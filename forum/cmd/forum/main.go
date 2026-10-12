// forum 是 SC2clud 的服务端：目前只做「提供前端产物 + 健康检查」。
// 业务接口按 完全重构/论坛后端技术方案-v2.md 逐步加，先让部署链路跑通。
package main

import (
	"bytes"
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
	devroom := flag.String("devroom-link", "", "非空时在页面右下角注入一个临时开发页入口（只给 dev 用，生产不传）")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	index := filepath.Join(*web, "index.html")
	raw, err := os.ReadFile(index)
	if err != nil {
		logger.Error("找不到前端产物，先跑 web 的 build", "path", index)
		os.Exit(1)
	}
	page := injectDevroom(raw, *devroom)
	if *devroom != "" {
		logger.Info("已注入临时开发页入口", "href", *devroom)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": version})
	})

	files := http.FileServer(http.Dir(*web))
	serveIndex := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		_, _ = w.Write(page)
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

// injectDevroom 在 </body> 前塞一个固定的临时入口。dev 专用：生产不传 -devroom-link 就原样输出。
func injectDevroom(html []byte, href string) []byte {
	if href == "" {
		return html
	}
	link := []byte(`<a href="` + href + `" style="position:fixed;right:16px;bottom:16px;z-index:9999;` +
		`display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:999px;` +
		`background:#111827;color:#fff;font:600 14px/1 system-ui,sans-serif;text-decoration:none;` +
		`box-shadow:0 6px 20px rgba(0,0,0,.28)">开发页面（临时）</a>`)
	return bytes.Replace(html, []byte("</body>"), append(link, []byte("</body>")...), 1)
}

// spa：命中静态文件就发文件，否则交给 index.html（前端路由自己解析路径）。否则刷新 /b/campaign 会 404。
func spa(root string, files http.Handler, serveIndex http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		clean := filepath.Join(root, filepath.Clean("/"+strings.TrimPrefix(r.URL.Path, "/")))
		if info, err := os.Stat(clean); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
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
