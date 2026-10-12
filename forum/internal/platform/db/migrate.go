package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"

	"github.com/golang-migrate/migrate/v4"
	migratepgx "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate 把库升到嵌入集的最高版本。幂等：已是最新返回 nil。
// 迁移用独立的 database/sql 连接（不是运行期的池）：迁移是部署动作，
// 混进同一个池会让「池被 worker 占满」变成「迁移卡住」。
func Migrate(ctx context.Context, dsn string, migrationFS fs.FS) error {
	src, err := iofs.New(migrationFS, ".")
	if err != nil {
		return fmt.Errorf("migrate: source: %w", err)
	}
	sqlDB, err := sql.Open("pgx/v5", dsn)
	if err != nil {
		return fmt.Errorf("migrate: open: %w", err)
	}
	defer func() { _ = sqlDB.Close() }()

	drv, err := migratepgx.WithInstance(sqlDB, &migratepgx.Config{})
	if err != nil {
		return fmt.Errorf("migrate: driver: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, "pgx5", drv)
	if err != nil {
		return fmt.Errorf("migrate: new: %w", err)
	}
	if err := m.Up(); err != nil {
		if errors.Is(err, migrate.ErrNoChange) {
			return nil
		}
		// golang-migrate 会把失败的版本标记为 dirty：这里把修复指引一起打出来
		return fmt.Errorf("migrate: up 失败（库可能处于 dirty 状态，修好 SQL 后先 migrate force <上一版>）: %w", err)
	}
	return nil
}

// CurrentVersion 读 schema_migrations 的版本与 dirty 标记。
// 表不存在（42P01）返回 version=0，表示「从未迁移过」。
func CurrentVersion(ctx context.Context, pool *pgxpool.Pool) (uint, bool, error) {
	var version int64
	var dirty bool
	err := pool.QueryRow(ctx, "SELECT version, dirty FROM schema_migrations LIMIT 1").Scan(&version, &dirty)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("db: read schema_migrations: %w", err)
	}
	return uint(version), dirty, nil
}

// EnsureVersion 是 forum run 的启动自检第 0 条：版本不一致就拒绝启动。
// 只比数字，不比表的形状——形状是 CI 与 forum check 的事。
func EnsureVersion(ctx context.Context, pool *pgxpool.Pool, embedded uint) error {
	version, dirty, err := CurrentVersion(ctx, pool)
	if err != nil {
		return err
	}
	if version == 0 && !dirty {
		return errors.New("db: 数据库还没迁移过，先跑 forum migrate")
	}
	if dirty {
		return fmt.Errorf("db: 迁移处于 dirty 状态（版本 %d）：修好后先 forum migrate force 再重跑", version)
	}
	if version != embedded {
		return fmt.Errorf("db: 数据库 schema 版本 %d 与二进制 %d 不一致，先跑 forum migrate", version, embedded)
	}
	return nil
}
