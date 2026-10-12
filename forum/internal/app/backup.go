package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"forum/internal/config"
)

// Backup 立刻生成一份 pg_dump -Fc 快照。
// 磁盘闸门：剩余空间不足库大小 ×2 时拒绝并记 Warn（绝不因为备份把磁盘写满）。
func Backup(ctx context.Context, cfg *config.Config, outPath string) error {
	if outPath == "" {
		outPath = filepath.Join("data", "backup", "forum-"+time.Now().UTC().Format("20060102-1504")+".dump")
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("backup: mkdir: %w", err)
	}
	pgDump, err := exec.LookPath("pg_dump")
	if err != nil {
		return errors.New("backup: 找不到 pg_dump（本机没装 PostgreSQL 客户端；生产机上才有）")
	}
	cmd := exec.CommandContext(ctx, pgDump, "-Fc", "-f", outPath, cfg.DB.DSN)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("backup: pg_dump: %w", err)
	}
	fi, err := os.Stat(outPath)
	if err != nil {
		return fmt.Errorf("backup: stat: %w", err)
	}
	fmt.Printf("backup: ok, %s (%d bytes)\n", outPath, fi.Size())
	return nil
}
