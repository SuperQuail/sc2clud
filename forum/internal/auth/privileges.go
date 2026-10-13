package auth

import (
	"context"
	"errors"
	"sort"
	"time"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/emailtoken"
	"forum/internal/ent/permission"
	"forum/internal/ent/role"
	"forum/internal/ent/rolepermission"
	"forum/internal/ent/session"
	"forum/internal/ent/user"
	"forum/internal/ent/userpermission"
	"forum/internal/platform/idgen"
)

// 三个提权操作的边界（设计 §8.8）：role.edit 管角色矩阵、role.assign 管基线角色、
// permission.grant 管点对点追加。**三者必须分开**：合并任意两个都能让持有者给自己提到最高权。

// ListRoles 给后台的角色列表（含每个角色的权限数与在用户数）。
func (s *Service) ListRoles(ctx context.Context, actor *authz.Actor) ([]RoleItem, error) {
	if err := requirePerm(actor, authz.PermRoleEdit); err != nil {
		return nil, err
	}
	roles, err := s.db.Role.Query().
		Order(ent.Asc(role.FieldPriority), ent.Asc(role.FieldID)).
		WithRolePermissions().
		All(ctx)
	if err != nil {
		return nil, err
	}
	// 用户数一次查出来，不要每个角色一次 count。
	counts := map[int64]int{}
	users, err := s.db.User.Query().Select(user.FieldRoleID).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, u := range users {
		counts[u.RoleID]++
	}

	out := make([]RoleItem, 0, len(roles))
	for _, r := range roles {
		keys := make([]string, 0, len(r.Edges.RolePermissions))
		for _, rp := range r.Edges.RolePermissions {
			if p, err := rp.Edges.PermissionOrErr(); err == nil {
				keys = append(keys, p.Key)
			}
		}
		sort.Strings(keys)
		out = append(out, RoleItem{
			ID: r.ID, Key: r.Key, Name: r.Name, Description: r.Description,
			Depth: r.Depth, BadgeColor: deref(r.BadgeColor),
			IsSystem: r.IsSystem, IsSuper: r.IsSuper, Priority: r.Priority,
			PermKeys: keys, UserCount: counts[r.ID],
		})
	}
	return out, nil
}

// ListPermissions 给后台勾选界面：目录来自 permissions 表（key 集合由启动自检与 authz 常量比对）。
// **权限点只能由迁移写入**（方案 §9.8 / 拍板 §1.2），所以这里没有「新增权限点」的入口。
func (s *Service) ListPermissions(ctx context.Context, actor *authz.Actor) ([]PermItem, error) {
	if err := requirePerm(actor, authz.PermRoleEdit); err != nil {
		return nil, err
	}
	rows, err := s.db.Permission.Query().Order(ent.Asc(permission.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]PermItem, 0, len(rows))
	for _, p := range rows {
		out = append(out, PermItem{Key: p.Key, Group: p.Grp, Name: p.Name, Description: p.Description})
	}
	return out, nil
}

// ReplaceRolePermsInput 是全量替换一个角色的权限矩阵。
type ReplaceRolePermsInput struct {
	RoleID   int64
	PermKeys []string
	IP       string
}

// ReplaceRolePermissions 全量替换（设计 §8.8）：先锁 role 行让两个管理员串行化，
// 校验权限点都真实存在，再一次 INSERT ... SELECT 写完，最后审计 before/after。
func (s *Service) ReplaceRolePermissions(ctx context.Context, actor *authz.Actor, in ReplaceRolePermsInput) error {
	if err := requirePerm(actor, authz.PermRoleEdit); err != nil {
		return err
	}
	keys := dedupe(in.PermKeys)
	return s.withTx(ctx, func(tx *ent.Tx) error {
		// FOR UPDATE：两个管理员同时保存同一角色的矩阵时串行化，后保存的赢（全量替换语义）。
		var roleKey string
		err := pgsql.QueryRow(ctx, tx.Client(), "SELECT key FROM roles WHERE id = $1 FOR UPDATE", in.RoleID).Scan(&roleKey)
		if err != nil {
			if ent.IsNotFound(err) {
				return ErrAdminRoleNotFound
			}
			return err
		}
		before, err := rolePermKeys(ctx, tx, in.RoleID)
		if err != nil {
			return err
		}
		// 权限点必须存在：不在表里的 key 是参数错误，不是「静默少勾一个」。
		if len(keys) > 0 {
			found, err := tx.Permission.Query().Where(permission.KeyIn(keys...)).Count(ctx)
			if err != nil {
				return err
			}
			if found != len(keys) {
				return ErrAdminPermUnknown
			}
		}
		if _, err := tx.RolePermission.Delete().Where(rolepermission.RoleIDEQ(in.RoleID)).Exec(ctx); err != nil {
			return err
		}
		if len(keys) > 0 {
			// 一次 INSERT ... SELECT，ORDER BY p.id 固定加锁顺序（避免两个并发矩阵编辑死锁）。
			if _, err := tx.ExecContext(ctx, insertRolePermsSQL, in.RoleID, keys); err != nil {
				return err
			}
		}
		after, err := rolePermKeys(ctx, tx, in.RoleID)
		if err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionRolePermsEdit, TargetType: "role",
			TargetID: roleKey, IP: ipOf(in.IP),
			Detail: map[string]any{
				"before": map[string]any{"perms": before},
				"after":  map[string]any{"perms": after},
			},
		})
	})
}

// insertRolePermsSQL 一条语句写完一个角色的全部勾选。不带 ON CONFLICT：上一句刚删空了这个角色。
const insertRolePermsSQL = "INSERT INTO role_permissions (role_id, permission_id) " +
	"SELECT $1, p.id FROM permissions p WHERE p.key = ANY($2::text[]) ORDER BY p.id"

func rolePermKeys(ctx context.Context, tx *ent.Tx, roleID int64) ([]string, error) {
	rows, err := tx.RolePermission.Query().
		Where(rolepermission.RoleIDEQ(roleID)).
		WithPermission().
		All(ctx)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(rows))
	for _, rp := range rows {
		if p, err := rp.Edges.PermissionOrErr(); err == nil {
			keys = append(keys, p.Key)
		}
	}
	sort.Strings(keys)
	return keys, nil
}

func dedupe(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

// SetUserRoleInput 改某个用户的基线角色（唯一真源是 users.role_id，拍板 §1.4）。
type SetUserRoleInput struct {
	UserPublicID string
	RoleID       int64
	IP           string
}

// SetUserRole 锁目标用户行让并发降权串行化；目标当前是超管时走 §8.9 的守卫。
func (s *Service) SetUserRole(ctx context.Context, actor *authz.Actor, in SetUserRoleInput) error {
	if err := requirePerm(actor, authz.PermRoleAssign); err != nil {
		return err
	}
	uid, err := idgen.ParsePublicID(in.UserPublicID)
	if err != nil {
		return ErrAdminUserNotFound
	}
	now := s.clk.Now()
	return s.withTx(ctx, func(tx *ent.Tx) error {
		// 锁目标行：两个管理员同时改同一个人时串行化。
		var targetID int64
		var publicID, oldRoleKey string
		err := pgsql.QueryRow(ctx, tx.Client(),
			"SELECT u.id, u.public_id, r.key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.public_id = $1 FOR UPDATE OF u",
			uid).Scan(&targetID, &publicID, &oldRoleKey)
		if err != nil {
			if ent.IsNotFound(err) {
				return ErrAdminUserNotFound
			}
			return err
		}
		newRole, err := tx.Role.Query().Where(role.IDEQ(in.RoleID)).Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return ErrAdminRoleNotFound
			}
			return err
		}
		if err := s.guardLastSuper(ctx, tx, targetID); err != nil {
			return err
		}
		if err := tx.User.UpdateOneID(targetID).SetRoleID(newRole.ID).SetUpdatedAt(now).Exec(ctx); err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionUserRoleAssign, TargetType: "user",
			TargetID: publicID, IP: ipOf(in.IP),
			Detail: map[string]any{
				"before": map[string]any{"role": oldRoleKey},
				"after":  map[string]any{"role": newRole.Key},
			},
		})
	})
}

// GrantPermInput 是点对点追加一个权限点。reason 必填（DB 也有 ck_user_permissions_reason）。
type GrantPermInput struct {
	UserPublicID string
	PermKey      string
	Reason       string
	ExpiresAt    *time.Time
	IP           string
}

// GrantPermission 是 upsert：同一个权限点再次授予 = 覆盖（改期限 / 改理由），不是 409。
// 管理员的意图是「把这个设成这样」，报错只会让他先删再加（设计 §8.8）。
func (s *Service) GrantPermission(ctx context.Context, actor *authz.Actor, in GrantPermInput) error {
	if err := requirePerm(actor, authz.PermPermissionGrant); err != nil {
		return err
	}
	if in.Reason == "" || len([]rune(in.Reason)) > 200 {
		return invalid("reason", "必须填写授权理由（200 字以内）")
	}
	now := s.clk.Now()
	if in.ExpiresAt != nil && !in.ExpiresAt.After(now) {
		return invalid("expires_at", "过期时间必须在将来")
	}
	target, err := s.userByPublicID(ctx, in.UserPublicID)
	if err != nil {
		return err
	}
	return s.withTx(ctx, func(tx *ent.Tx) error {
		permID, err := tx.Permission.Query().Where(permission.KeyEQ(in.PermKey)).OnlyID(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return ErrAdminPermUnknown
			}
			return err
		}
		// xmax = 0 表示这一行是本次插入的（而不是覆盖），审计里带上它便于排障。
		var inserted bool
		err = pgsql.QueryRow(ctx, tx.Client(), grantPermSQL,
			target.ID, permID, actor.UserID, now, in.ExpiresAt, in.Reason).Scan(&inserted)
		if err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionPermissionGrant, TargetType: "user",
			TargetID: target.PublicID.String(), IP: ipOf(in.IP),
			Detail: map[string]any{"after": map[string]any{
				"perm": in.PermKey, "expires_at": in.ExpiresAt, "reason": in.Reason, "inserted": inserted,
			}},
		})
	})
}

const grantPermSQL = "INSERT INTO user_permissions (user_id, permission_id, granted_by, granted_at, expires_at, reason) " +
	"VALUES ($1, $2, $3, $4, $5, $6) " +
	"ON CONFLICT (user_id, permission_id) DO UPDATE " +
	"SET granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, " +
	"expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason " +
	"RETURNING (xmax = 0)"

// RevokePermission 回收一条追加。删不到 → 404（「这条追加不存在」，不是「操作成功」）。
func (s *Service) RevokePermission(ctx context.Context, actor *authz.Actor, userPublicID, permKey, ip string) error {
	if err := requirePerm(actor, authz.PermPermissionGrant); err != nil {
		return err
	}
	target, err := s.userByPublicID(ctx, userPublicID)
	if err != nil {
		return err
	}
	return s.withTx(ctx, func(tx *ent.Tx) error {
		permID, err := tx.Permission.Query().Where(permission.KeyEQ(permKey)).OnlyID(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return ErrAdminPermUnknown
			}
			return err
		}
		before, err := tx.UserPermission.Query().
			Where(userpermission.UserIDEQ(target.ID), userpermission.PermissionIDEQ(permID)).
			Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return errPermGrantNotFound
			}
			return err
		}
		if _, err := tx.UserPermission.Delete().
			Where(userpermission.UserIDEQ(target.ID), userpermission.PermissionIDEQ(permID)).
			Exec(ctx); err != nil {
			return err
		}
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionPermissionRevoke, TargetType: "user",
			TargetID: target.PublicID.String(), IP: ipOf(ip),
			Detail: map[string]any{"before": map[string]any{
				"perm": permKey, "expires_at": before.ExpiresAt, "reason": before.Reason,
			}},
		})
	})
}

// PruneExpiredGrants 删「已过期 ≥7 天」的追加权限行，并各写一条 permission.expire 审计。
// 过期行清理**不是正确性要求**（权限查询本来就过滤 expires_at），只是防表变胖（设计 §5.7）。
func (s *Service) PruneExpiredGrants(ctx context.Context, before time.Time) (int, error) {
	type expiredGrant struct {
		UserID   int64
		PublicID string
		PermKey  string
		Expires  *time.Time
	}
	var all []expiredGrant
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		rows, err := tx.UserPermission.Query().
			Where(userpermission.ExpiresAtLT(before)).
			WithPermission().
			All(ctx)
		if err != nil {
			return err
		}
		for _, r := range rows {
			p, err := r.Edges.PermissionOrErr()
			if err != nil {
				return err
			}
			var pub string
			if err := pgsql.QueryRow(ctx, tx.Client(), "SELECT public_id FROM users WHERE id = $1", r.UserID).Scan(&pub); err != nil {
				if !ent.IsNotFound(err) {
					return err
				}
				continue // 用户行不在了：追加权限是审计材料，不写审计就地留着（下一轮仍会被选中）
			}
			all = append(all, expiredGrant{r.UserID, pub, p.Key, r.ExpiresAt})
		}
		for _, r := range all {
			if err := s.writeAudit(ctx, tx, AuditEntry{
				Action: ActionPermissionExpire, TargetType: "user", TargetID: r.PublicID,
				Detail: map[string]any{"before": map[string]any{"perm": r.PermKey, "expires_at": r.Expires}},
			}); err != nil {
				return err
			}
		}
		if len(all) == 0 {
			return nil
		}
		_, err = tx.UserPermission.Delete().Where(userpermission.ExpiresAtLT(before)).Exec(ctx)
		return err
	})
	if err != nil {
		return 0, err
	}
	return len(all), nil
}

// PruneSessions 删「过期 ≥7 天」的会话行（设计 §5.2）。
func (s *Service) PruneSessions(ctx context.Context, before time.Time) (int, error) {
	n, err := s.db.Session.Delete().Where(session.ExpiresAtLT(before)).Exec(ctx)
	if err != nil {
		return 0, err
	}
	return n, nil
}

// PruneEmailTokens 删「过期 ≥7 天」的令牌行。
func (s *Service) PruneEmailTokens(ctx context.Context, before time.Time) (int, error) {
	n, err := s.db.EmailToken.Delete().Where(emailtoken.ExpiresAtLT(before)).Exec(ctx)
	if err != nil {
		return 0, err
	}
	return n, nil
}

// errPermGrantNotFound 是「这条追加不存在」：对外 404 common.not_found。
var errPermGrantNotFound = errors.New("auth: 这条追加权限不存在")

var _ = user.FieldID
