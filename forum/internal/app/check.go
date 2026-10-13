package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"forum/internal/config"
	"forum/internal/platform/db"
	"forum/migrations"
)

// Check 是「这条命还能不能干活」的体检：真实依赖探测 + 迁移版本 + 自检 SQL。
// 有 fail 即非 0 退出（main 负责退出码）。Warn 不影响退出码。
func Check(ctx context.Context, cfg *config.Config) error {
	var errs []error

	fmt.Printf("check: env=%s base=%s db=%s\n", cfg.Env, cfg.Site.BaseURL, redactDSN(cfg.DB.DSN))

	pool, err := openPoolForCommand(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	fmt.Println("check: db ping ok")

	latest, err := migrations.Latest()
	if err != nil {
		return err
	}
	version, dirty, err := db.CurrentVersion(ctx, pool)
	if err != nil {
		return err
	}
	switch {
	case version == 0 && !dirty:
		errs = append(errs, errors.New("fail: 数据库还没迁移过，先跑 forum migrate"))
	case dirty:
		errs = append(errs, fmt.Errorf("fail: 迁移处于 dirty 状态（版本 %d）", version))
	case version != latest:
		errs = append(errs, fmt.Errorf("fail: 数据库版本 %d != 二进制版本 %d", version, latest))
	default:
		fmt.Printf("check: migration version=%d ok\n", version)
	}

	if err := db.WriteProbe(cfg.Image.Root); err != nil {
		errs = append(errs, fmt.Errorf("fail: image.root 不可写: %w", err))
	} else {
		fmt.Printf("check: image.root 可写 %s\n", cfg.Image.Root)
	}

	// 自检 SQL（数据库文档 §12 第 1 条）：有结果就是有外键没索引
	if version != 0 && !dirty {
		rows, err := db.SelfCheck(ctx, pool)
		if err != nil {
			errs = append(errs, fmt.Errorf("fail: 自检 SQL: %w", err))
		}
		for _, row := range rows {
			errs = append(errs, fmt.Errorf("fail: %s", row))
		}
		if len(rows) == 0 {
			fmt.Println("check: 外键索引自检通过")
		}
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	fmt.Println("check: ok")
	return nil
}

// redactDSN 去掉连接串里的口令：check 的输出会进日志与部署报告。
func redactDSN(dsn string) string {
	i := strings.Index(dsn, "://")
	if i < 0 {
		return "***"
	}
	rest := dsn[i+3:]
	at := strings.Index(rest, "@")
	if at < 0 {
		return dsn
	}
	if colon := strings.Index(rest, ":"); colon >= 0 && colon < at {
		return dsn[:i+3] + "***" + rest[at:]
	}
	return dsn
}
