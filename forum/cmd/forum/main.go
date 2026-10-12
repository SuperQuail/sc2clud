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
	if _, err := os.Stat(index); err != nil {
		logger.Error("找不到前端产物，先跑 web 的 build", "path", index)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": version})
	})

	files := http.FileServer(http.Dir(*web))
	mux.Handle("/", spa(*web, files))

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

// spa：命中静态文件就发文件，否则交给 index.html（前端路由自己解析路径）。否则刷新 /b/campaign 会 404。
func spa(root string, files http.Handler) http.Handler {
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
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
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
