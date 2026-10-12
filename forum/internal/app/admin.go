package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"forum/internal/config"
)

// CreateAdmin 是唯一能产生第一个超管的路径（拍板 §1.3），所以它不能依赖任何已存在的用户。
// 幂等：用户名不存在就创建，存在就提升为 superadmin 并重置口令。
// 依赖 P1 的表与 seed：roles/permissions 与 superadmin 角色由 0017_seed_authz 写入。
func CreateAdmin(ctx context.Context, cfg *config.Config, username, password string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return errors.New("create-admin: 用户名不能为空")
	}
	if len(password) < 8 {
		return errors.New("create-admin: 口令至少 8 位")
	}
	pool, err := openPoolForCommand(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	// P0 只打通链路：口令哈希与 users 表的列在 P1/P2 落地后替换这两条语句。
	// 现在这样做有明确代价：它写的是一个不可登录的占位值，且 id 由 users 表的序列给。
	var roleID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM roles WHERE key = 'superadmin'`).Scan(&roleID); err != nil {
		return fmt.Errorf("create-admin: 读 superadmin 角色失败（表结构与 seed 由 P1 的迁移写入，先跑 forum migrate）: %w", err)
	}

	var userID int64
	err = pool.QueryRow(ctx, `
INSERT INTO users (public_id, username, email, password_hash, role_id, email_verified_at, status)
VALUES (gen_random_uuid(), $1, $1 || '@localhost', '!pending-p1', $2, now(), 'active')
ON CONFLICT (lower(username)) DO UPDATE SET role_id = EXCLUDED.role_id, password_hash = EXCLUDED.password_hash
RETURNING id`, username, roleID).Scan(&userID)
	if err != nil {
		return fmt.Errorf("create-admin: 写用户失败: %w", err)
	}
	fmt.Printf("create-admin: ok, user_id=%d username=%s role=superadmin\n", userID, username)
	fmt.Println("注意：口令哈希要等 P2 的密码哈希落地后才是可登录的（当前占位）")
	return nil
}
