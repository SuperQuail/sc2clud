package forum

import (
	"context"
	"errors"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/forum/pgsql"
	"forum/internal/platform/idgen"
)

// 分区的 ACL 矩阵与版主任免（交接单 C2 / 界面需求 §5.3 + §5.10）。权限点一律 board.manage。

// ── ACL 矩阵 ─────────────────────────────────────────────────────

// AdminBoardACL 读一个分区的整张矩阵。
func (s *Service) AdminBoardACL(ctx context.Context, actor *authz.Actor, publicID string) ([]AdminACLItem, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	id, err := s.boardIDByPublicID(ctx, s.db, publicID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.AdminACL(ctx, s.db, id, false)
	if err != nil {
		return nil, err
	}
	return adminACLItems(rows), nil
}

// ReplaceBoardACL 全量替换整张矩阵。
//
// 三处「不静默」：角色不存在 → 400；同一行既 can 又 deny → 400；重复 role_id → 400。
// 第三条尤其重要：后一行会覆盖前一行，不报错的话管理员看到的结果与他勾的不是一回事。
func (s *Service) ReplaceBoardACL(ctx context.Context, actor *authz.Actor, publicID string, items []AdminACLItem) ([]AdminACLItem, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	seen := make(map[int64]bool, len(items))
	for i, it := range items {
		if it.RoleID <= 0 {
			return nil, invalid("acls", "第 "+itoa64(int64(i+1))+" 行没有 role_id")
		}
		if seen[it.RoleID] {
			return nil, invalid("acls", "同一个角色只能有一行")
		}
		seen[it.RoleID] = true
		if (it.DenyPost && it.CanPost) || (it.DenyReply && it.CanReply) {
			// 「禁止优先」要求同一行不能自相矛盾：两个都为真时判定虽然能选出 deny，
			// 但界面上会同时显示两个勾，而管理员勾的是「允许」、最后生效的却是「禁止」——
			// 这件事在 UI 上说不出。DB 的 ck_board_acls_no_contradiction 也拦，但约束报错指不到是哪一格。
			return nil, invalid("acls", "同一行的「允许」与「禁止」不能同时勾上")
		}
	}
	ids := make([]int64, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.RoleID)
	}
	var out []AdminACLItem
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		boardID, err := s.boardIDByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		// 先锁分区行：两个管理员同时保存同一张矩阵时串行化，后保存的赢（全量替换语义）。
		if err := pgsql.LockBoard(ctx, tx, boardID); err != nil {
			return err
		}
		if n, err := pgsql.RolesExist(ctx, tx, ids); err != nil {
			return err
		} else if n != len(ids) {
			return invalid("acls", "有角色不存在（可能刚被删掉），请刷新角色列表")
		}
		before, err := s.repo.AdminACL(ctx, tx, boardID, true)
		if err != nil {
			return err
		}
		rows := make([]pgsql.AdminACLRow, 0, len(items))
		for _, it := range items {
			rows = append(rows, pgsql.AdminACLRow{
				RoleID: it.RoleID, CanPost: it.CanPost, CanReply: it.CanReply,
				DenyPost: it.DenyPost, DenyReply: it.DenyReply,
			})
		}
		if err := pgsql.SetAdminACL(ctx, tx, boardID, rows); err != nil {
			return err
		}
		after, err := s.repo.AdminACL(ctx, tx, boardID, false)
		if err != nil {
			return err
		}
		out = adminACLItems(after)
		return s.writeBoardAudit(ctx, tx, actor, AuditBoardACLUpdate, publicID, map[string]any{
			"before": aclToMap(before),
			"after":  aclToMap(after),
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func adminACLItems(rows []pgsql.AdminACLRow) []AdminACLItem {
	out := make([]AdminACLItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, AdminACLItem{
			RoleID: r.RoleID, RoleKey: r.RoleKey,
			CanPost: r.CanPost, CanReply: r.CanReply,
			DenyPost: r.DenyPost, DenyReply: r.DenyReply,
		})
	}
	return out
}

// aclToMap 把矩阵写成审计里的形状：role_key → 四象限。用 key 不用 id ——
// 半年后看审计的人不知道 id 是几。
func aclToMap(rows []pgsql.AdminACLRow) map[string]any {
	m := make(map[string]any, len(rows))
	for _, r := range rows {
		m[r.RoleKey] = map[string]bool{
			"can_post": r.CanPost, "can_reply": r.CanReply,
			"deny_post": r.DenyPost, "deny_reply": r.DenyReply,
		}
	}
	return m
}

// ── 版主任免 ─────────────────────────────────────────────────────

// AdminBoardModerators 列出该分区的全部任期（在任的在前，含已卸任的历史行）。
func (s *Service) AdminBoardModerators(ctx context.Context, actor *authz.Actor, publicID string) ([]AdminModeratorItem, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	id, err := s.boardIDByPublicID(ctx, s.db, publicID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.AdminModerators(ctx, s.db, id)
	if err != nil {
		return nil, err
	}
	return adminModeratorItems(rows), nil
}

func adminModeratorItems(rows []pgsql.AdminModeratorRow) []AdminModeratorItem {
	out := make([]AdminModeratorItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, AdminModeratorItem{
			AdminModerator: AdminModerator{
				UserID: r.UserID, Handle: r.Handle, Nickname: r.Nickname,
				GrantedAt: r.GrantedAt.UTC(), ExpiresAt: utcOrNil(r.ExpiresAt),
			},
			GrownAt: utcOrNil(r.GrownAt),
		})
	}
	return out
}

// GrantBoardModerator 任命一个版主（幂等：重复任命 = 改任期与任命人）。
// expires_at 为空 = 永久；给了必须是将来（给一个已经过去的任期等于任命完立刻卸任）。
func (s *Service) GrantBoardModerator(ctx context.Context, actor *authz.Actor, boardPublicID, userPublicID string, expiresAt *time.Time) ([]AdminModeratorItem, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	if expiresAt != nil && !expiresAt.After(s.clk.Now()) {
		return nil, invalid("expires_at", "任期必须在将来")
	}
	now := s.clk.Now()
	var out []AdminModeratorItem
	var targetID int64
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		boardID, err := s.boardIDByPublicID(ctx, tx, boardPublicID)
		if err != nil {
			return err
		}
		targetID, err = s.userIDByPublicID(ctx, tx, userPublicID)
		if err != nil {
			return err
		}
		// 上限只在**新增**时判：同一个人重复任命（改任期）不该被自己占的名额挡住。
		already, err := pgsql.IsActiveModerator(ctx, tx, boardID, targetID)
		if err != nil {
			return err
		}
		if !already {
			if n, err := pgsql.CountActiveModerators(ctx, tx, boardID); err != nil {
				return err
			} else if n >= maxBoardModerator {
				return invalid("user_id", "一个分区的版主最多 "+itoa64(maxBoardModerator)+" 人")
			}
		}
		if err := pgsql.UpsertAdminModerator(ctx, tx, boardID, targetID, actor.UserID, expiresAt, now); err != nil {
			return err
		}
		rows, err := s.repo.AdminModerators(ctx, tx, boardID)
		if err != nil {
			return err
		}
		out = adminModeratorItems(rows)
		return s.writeBoardAudit(ctx, tx, actor, AuditBoardModerateGrant, boardPublicID, map[string]any{
			"after": map[string]any{"user_id": userPublicID, "expires_at": expiresAt},
		})
	})
	if err != nil {
		return nil, err
	}
	// 权限快照失效：不调的话这个人在缓存过期前仍然是该分区的版主（能锁主题、能关 Issue）。
	if err := s.invalidateUser(ctx, targetID); err != nil {
		return nil, err
	}
	return out, nil
}

// RevokeBoardModerator 免掉一个版主：置 grown_at（**不删行** —— 删了就答不出「谁什么时候被免的」）。
func (s *Service) RevokeBoardModerator(ctx context.Context, actor *authz.Actor, boardPublicID, userPublicID string) error {
	if err := requireBoardManage(actor); err != nil {
		return err
	}
	now := s.clk.Now()
	var targetID int64
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		boardID, err := s.boardIDByPublicID(ctx, tx, boardPublicID)
		if err != nil {
			return err
		}
		targetID, err = s.userIDByPublicID(ctx, tx, userPublicID)
		if err != nil {
			return err
		}
		n, err := pgsql.RevokeAdminModerator(ctx, tx, boardID, targetID, now)
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrAdminModeratorNotFound
		}
		return s.writeBoardAudit(ctx, tx, actor, AuditBoardModerateRevoke, boardPublicID, map[string]any{
			"before": map[string]any{"user_id": userPublicID},
		})
	})
	if err != nil {
		return err
	}
	return s.invalidateUser(ctx, targetID)
}

// userIDByPublicID 把用户的对外 ID 换成自增 id（版主任免的两个端点都要）。
func (s *Service) userIDByPublicID(ctx context.Context, q pgsql.Querier, publicID string) (int64, error) {
	id, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return 0, ErrAdminModeratorUserNotFound
	}
	var userID int64
	err = pgsql.QueryRow(ctx, q, "SELECT id FROM users WHERE public_id = $1", id.String()).Scan(&userID)
	if err != nil {
		if errors.Is(err, pgsql.ErrNoRows) {
			return 0, ErrAdminModeratorUserNotFound
		}
		return 0, err
	}
	return userID, nil
}
