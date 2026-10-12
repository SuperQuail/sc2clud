package app

import (
	"context"
	"fmt"

	"forum/internal/config"
	"forum/migrations"
	"forum/internal/platform/db"
)

// Migrate 执行全部未应用的迁移。失败即非 0 退出（由 main 负责退出码）。
func Migrate(ctx context.Context, cfg *config.Config) error {
	latest, err := migrations.Latest()
	if err != nil {
		return err
	}
	if err := db.Migrate(ctx, cfg.DB.DSN, migrations.FS()); err != nil {
		return err
	}
	return printVersionNow(ctx, cfg, latest)
}

// printVersionNow 打印迁移后的实际版本：部署脚本靠这一行确认「迁移真的生效了」。
func printVersionNow(ctx context.Context, cfg *config.Config, want uint) error {
	pool, err := openPoolForCommand(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	got, dirty, err := db.CurrentVersion(ctx, pool)
	if err != nil {
		return err
	}
	if dirty {
		return fmt.Errorf("migrate: 结束后仍处于 dirty 状态（版本 %d）", got)
	}
	if got != want {
		return fmt.Errorf("migrate: 期望版本 %d，实际 %d", want, got)
	}
	fmt.Printf("migrate: ok, version=%d\n", got)
	return nil
}
