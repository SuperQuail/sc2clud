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
	"forum/internal/platform/db"
	"forum/migrations"
)

// Run 是 forum run：起 HTTP + worker + cron + counter，并按固定顺序优雅关闭。
//
// 启动顺序写死（上线设计 §2 P1 决策 5）：
// 迁移版本 → 装配各域 → 自检（权限点 / 枚举 / 角色种子 / 外键索引）→ 注册任务 → 才监听。
// **自检失败就拒绝启动**：带着错的权限表跑起来，坏的是一条永远判不过的鉴权（静默失效）。
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

	// 装配：任何一处接不上都在这里失败，不让半个装配跑起来。
	m, err := newModules(ctx, cfg, in)
	if err != nil {
		return err
	}
	if err := selfCheck(ctx, m, in); err != nil {
		return err
	}
	log.Info("启动自检通过")

	registerTasks(in, m)

	srv, err := newHTTPServer(cfg, in, m, bi)
	if err != nil {
		return err
	}

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { return runWorker(gctx, in) })
	g.Go(func() error { return runCron(gctx, in) })
	g.Go(func() error { return in.Counter.Run(gctx) })
	// 会话活跃时间的批量刷写（auth 的 toucher）：关闭时把在途的一批写完再返回。
	g.Go(func() error { return m.Auth.StartTouch(gctx) })
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

// selfCheck 是「开始监听之前」的全部自检。跑在迁移版本之后（表必须已经就位）。
//
// 三条来自 auth 的设计 §14：权限点 / 枚举 / 角色种子；外加一条全库的外键索引扫描。
// 都失败即拒绝启动（与 forum check 同一个判定，只是 check 不拦启动、这里拦）。
func selfCheck(ctx context.Context, m *Modules, in *Infra) error {
	var errs []error
	if err := m.Auth.CheckPermissions(ctx); err != nil {
		errs = append(errs, err)
	}
	if err := m.Auth.CheckEnums(ctx); err != nil {
		errs = append(errs, err)
	}
	if err := m.Auth.CheckRoleSeeds(ctx); err != nil {
		errs = append(errs, err)
	}
	// 外键列没有索引：删父行时全表扫。auth 那边有一个同款检查，但它要 database/sql 的形状，
	// 而这里手上是 pgx 池；platform/db 的 SelfCheck 是同一段 SQL，直接用（forum check 也用它）。
	if rows, err := db.SelfCheck(ctx, in.Pool); err != nil {
		errs = append(errs, err)
	} else {
		for _, row := range rows {
			errs = append(errs, errors.New(row))
		}
	}
	return errors.Join(errs...)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%v", err)
}
