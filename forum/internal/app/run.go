package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sync/errgroup"

	"forum/internal/config"
	"forum/migrations"
	"forum/internal/platform/db"
)

// Run 是 forum run：起 HTTP + worker + cron + counter，并按固定顺序优雅关闭。
//
// 关闭顺序（写死）：HTTP → worker → cron → counter flush → 关数据库。
// 顺序不是靠 errgroup 的启动顺序，而是靠「谁在谁之后观察到 ctx.Done 并返回」。
func Run(ctx context.Context, cfg *config.Config, bi BuildInfo) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	log, err := newLogger(cfg.Log)
	if err != nil {
		return err
	}
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer in.Close()

	// 启动自检第 0 条：版本不对就拒绝启动（用旧二进制跑新库会静默产生「列不存在」）
	latest, err := migrations.Latest()
	if err != nil {
		return err
	}
	if err := db.EnsureVersion(ctx, in.Pool, latest); err != nil {
		return err
	}
	log.Info("迁移版本一致", "version", latest)

	registerTasks(in)

	srv, err := newHTTPServer(cfg, in, bi)
	if err != nil {
		return err
	}

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { return runWorker(gctx, in) })
	g.Go(func() error { return runCron(gctx, in) })
	g.Go(func() error { return in.Counter.Run(gctx) })
	g.Go(func() error {
		log.Info("http 监听", "addr", cfg.HTTP.Addr)
		if err := srv.Srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	g.Go(func() error {
		<-gctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout(cfg))
		defer cancel()
		log.Info("开始优雅关闭", "timeout", shutdownTimeout(cfg))
		return srv.Srv.Shutdown(shutdownCtx)
	})

	err = g.Wait()
	log.Info("已退出", "err", errString(err))
	return err
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%v", err)
}
