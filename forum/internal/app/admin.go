package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"forum/internal/auth"
	"forum/internal/config"
)

// CreateAdmin 是唯一能产生第一个超管的路径（拍板 §1.3），所以它不能依赖任何已存在的用户。
//
// 走的是 auth.Service.CreateAdmin（口令用 argon2id 真哈希落库，可登录）；装配与 run 同一份
// （newModules），所以这里不需要第二套依赖连接。
//
// 与 P0 那版的两点差别（那时写的是不可登录的占位口令）：
//   - 用户名已存在时**不**降级成「提升为超管」，而是报错：提权是管理端的动作（role.assign），
//     CLI 只在「一个人都没有」时用（d2 §8.7）；
//   - email 必须是真的邮箱形状，所以命令行多了一个 -email（默认 <username>@sc2clud.local）。
func CreateAdmin(ctx context.Context, cfg *config.Config, username, email, password string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return errors.New("create-admin: 用户名不能为空")
	}
	if len(password) < 8 {
		return errors.New("create-admin: 口令至少 8 位")
	}
	if strings.TrimSpace(email) == "" {
		email = username + "@sc2clud.local"
	}
	log, err := newLogger(cfg.Log)
	if err != nil {
		return err
	}
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer in.Close()
	m, err := newModules(ctx, cfg, in)
	if err != nil {
		return err
	}
	err = m.Auth.CreateAdmin(ctx, auth.CreateAdminInput{
		Handle: username, Email: email, Nickname: username, Password: password,
	})
	if err != nil {
		return fmt.Errorf("create-admin: %w", err)
	}
	fmt.Printf("create-admin: ok, username=%s email=%s role=superadmin\n", username, email)
	return nil
}
