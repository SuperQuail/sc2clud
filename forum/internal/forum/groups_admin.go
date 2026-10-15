package forum

import (
	"context"
	"errors"
	"strings"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/forum/pgsql"
)

// 用户组管理（D38）：组 CRUD、组员增删查、分区 × 组 ACL 行。分工照分区管理那组：
//   组与组员 → user.ban（动的是「谁是谁组的」，不是角色矩阵）
//   分区的组矩阵 → board.manage（与角色矩阵同闸）

const (
	maxGroupNameLen = 32
	maxGroupDescLen = 200
)

// 组管理的审计动作名（屏上照 key 显示；audit 屏的 ACTION_LABEL 有对应中文标签）。
const (
	AuditGroupCreate       = "group.create"
	AuditGroupUpdate       = "group.update"
	AuditGroupDelete       = "group.delete"
	AuditGroupMemberAdd    = "group.member.add"
	AuditGroupMemberRemove = "group.member.remove"

	// 分区 × 组矩阵的替换审计（与 AuditBoardACLUpdate 并排）。
	AuditBoardGroupACLUpdate = "board.group_acl.update"
)

// AdminGroupDTO 是后台组目录的一行。
type AdminGroupDTO struct {
	ID          string    `json:"id"`
	Key         string    `json:"key"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	MemberCount int64     `json:"member_count"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// AdminGroupMember 是组员名单的一行（user_id 是对外 uuid，前端直接调 /u/<handle>）。
type AdminGroupMember struct {
	UserID   string    `json:"user_id"`
	Handle   string    `json:"handle"`
	Nickname string    `json:"nickname"`
	AddedAt  time.Time `json:"added_at"`
}

// AdminGroupACLItem 是分区 × 组矩阵的一格。行以 **group_key** 为标识（组目录给前端的是
// key，自增 id 不出 API 拍板同款；校验/落库在 service 里照 key 做）。
type AdminGroupACLItem struct {
	GroupKey  string `json:"group_key"`
	CanPost   bool   `json:"can_post"`
	CanReply  bool   `json:"can_reply"`
	DenyPost  bool   `json:"deny_post"`
	DenyReply bool   `json:"deny_reply"`
}

// CreateGroupInput / UpdateGroupInput / inputs
type CreateGroupInput struct {
	Key         string
	Name        string
	Description string
}

type UpdateGroupInput struct {
	Name        *string
	Description *string
}

// requireUserBan 是组这条线（组与组员）的第一道闸——先 actor 再权限点（同 requireBoardManage）。
func requireUserBan(actor *authz.Actor) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	return requirePerm(actor, authz.PermUserBan)
}

func adminGroupDTO(r pgsql.AdminGroupRow) AdminGroupDTO {
	return AdminGroupDTO{
		ID:          r.PublicID,
		Key:         r.Key,
		Name:        r.Name,
		Description: r.Description,
		MemberCount: r.MemberCount,
		CreatedAt:   r.CreatedAt.UTC(),
		UpdatedAt:   r.UpdatedAt.UTC(),
	}
}

// validateGroupKey 照 boardSlugRe：key 是稳定标识（建后不可改），小写字母数字与连字符。
func validateGroupKey(key string) error {
	if !boardSlugRe.MatchString(key) {
		return invalid("key", "2-32 位小写字母、数字或连字符，且以字母数字开头")
	}
	return nil
}

// ── 组 CRUD ──────────────────────────────────────────────────────

func (s *Service) AdminListGroups(ctx context.Context, actor *authz.Actor) ([]AdminGroupDTO, error) {
	if err := requireUserBan(actor); err != nil {
		return nil, err
	}
	rows, err := s.repo.AdminGroups(ctx, s.db)
	if err != nil {
		return nil, err
	}
	out := make([]AdminGroupDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, adminGroupDTO(r))
	}
	return out, nil
}

// AdminCreateGroup 建组。
func (s *Service) AdminCreateGroup(ctx context.Context, actor *authz.Actor, in CreateGroupInput) (*AdminGroupDTO, error) {
	if err := requireUserBan(actor); err != nil {
		return nil, err
	}
	key := strings.TrimSpace(in.Key)
	name := strings.TrimSpace(in.Name)
	desc := strings.TrimSpace(in.Description)
	if err := validateGroupKey(key); err != nil {
		return nil, err
	}
	if name == "" || len([]rune(name)) > maxGroupNameLen {
		return nil, invalid("name", "名称必填，最多 32 个字")
	}
	if len([]rune(desc)) > maxGroupDescLen {
		return nil, invalid("description", "简介最多 200 个字")
	}
	now := s.clk.Now()
	var createdPublic string
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		_, pub, err := pgsql.InsertAdminGroup(ctx, tx, key, name, desc, actor.UserID, now)
		if err != nil {
			if isUniqueViolation(err) {
				return invalid("key", "这个 key 已经被占用")
			}
			return err
		}
		createdPublic = pub
		return pgsql.InsertGroupAudit(ctx, tx, actor.UserID, AuditGroupCreate, pub, map[string]any{
			"after": map[string]any{"key": key, "name": name},
		}, now)
	})
	if err != nil {
		return nil, err
	}
	row, err := s.repo.AdminGroupByPublicID(ctx, s.db, createdPublic)
	if err != nil {
		return nil, err
	}
	d := adminGroupDTO(*row)
	return &d, nil
}

// AdminUpdateGroup 改组：只改给了的字段（指针 = 没给）。没有 Key —— key 建后不可改。
func (s *Service) AdminUpdateGroup(ctx context.Context, actor *authz.Actor, publicID string, in UpdateGroupInput) (*AdminGroupDTO, error) {
	if err := requireUserBan(actor); err != nil {
		return nil, err
	}
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if n == "" || len([]rune(n)) > maxGroupNameLen {
			return nil, invalid("name", "名称必填，最多 32 个字")
		}
		in.Name = &n
	}
	if in.Description != nil {
		d := strings.TrimSpace(*in.Description)
		if len([]rune(d)) > maxGroupDescLen {
			return nil, invalid("description", "简介最多 200 个字")
		}
		in.Description = &d
	}
	if in.Name == nil && in.Description == nil {
		return nil, invalid("_", "没有要改的字段")
	}
	now := s.clk.Now()
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		g, err := s.groupByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		before := map[string]any{"name": g.Name, "description": g.Description}
		changed := map[string]any{}
		name, description := g.Name, g.Description
		if in.Name != nil {
			name = *in.Name
			changed["name"] = *in.Name
		}
		if in.Description != nil {
			description = *in.Description
			changed["description"] = *in.Description
		}
		if err := pgsql.UpdateAdminGroup(ctx, tx, g.ID, name, description, actor.UserID, now); err != nil {
			return err
		}
		return pgsql.InsertGroupAudit(ctx, tx, actor.UserID, AuditGroupUpdate, g.PublicID, map[string]any{
			"before": before,
			"after":  changed,
		}, now)
	})
	if err != nil {
		return nil, err
	}
	row, err := s.repo.AdminGroupByPublicID(ctx, s.db, publicID)
	if err != nil {
		if errors.Is(err, pgsql.ErrNoRows) {
			return nil, ErrGroupNotFound
		}
		return nil, err
	}
	d := adminGroupDTO(*row)
	return &d, nil
}

// AdminDeleteGroup 删组（组员与分区组行随 CASCADE —— 权限立即收回，无需缓存失效）。
func (s *Service) AdminDeleteGroup(ctx context.Context, actor *authz.Actor, publicID string) error {
	if err := requireUserBan(actor); err != nil {
		return err
	}
	now := s.clk.Now()
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		g, err := s.groupByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		if _, err := pgsql.DeleteAdminGroup(ctx, tx, g.ID); err != nil {
			return err
		}
		return pgsql.InsertGroupAudit(ctx, tx, actor.UserID, AuditGroupDelete, g.PublicID, map[string]any{
			"before": map[string]any{"key": g.Key, "name": g.Name, "members": g.MemberCount},
		}, now)
	})
	if err != nil {
		return err
	}
	return nil
}

// groupByPublicID：对外 ID 换组行（非 uuid 与不存在同一 404 —— 同 boardIDByPublicID 的取舍）。
func (s *Service) groupByPublicID(ctx context.Context, q pgsql.Querier, publicID string) (*pgsql.AdminGroupRow, error) {
	g, err := s.repo.AdminGroupByPublicID(ctx, q, publicID)
	if err != nil {
		if errors.Is(err, pgsql.ErrNoRows) {
			return nil, ErrGroupNotFound
		}
		return nil, err
	}
	return g, nil
}

// ── 组员 ─────────────────────────────────────────────────────────

func adminGroupMemberItems(rows []pgsql.AdminGroupMemberRow) []AdminGroupMember {
	out := make([]AdminGroupMember, 0, len(rows))
	for _, r := range rows {
		out = append(out, AdminGroupMember{
			UserID: r.UserID, Handle: r.Handle, Nickname: r.Nickname,
			AddedAt: r.AddedAt.UTC(),
		})
	}
	return out
}

// AdminGroupMembers 列出组员。
func (s *Service) AdminGroupMembers(ctx context.Context, actor *authz.Actor, publicID string) ([]AdminGroupMember, error) {
	if err := requireUserBan(actor); err != nil {
		return nil, err
	}
	var out []AdminGroupMember
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		g, err := s.groupByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		rows, err := s.repo.AdminGroupMembers(ctx, tx, g.ID)
		if err != nil {
			return err
		}
		out = adminGroupMemberItems(rows)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// AdminAddGroupMember 拉人入组（判定是直查名单 —— 生效不需要任何缓存失效）。
func (s *Service) AdminAddGroupMember(ctx context.Context, actor *authz.Actor, publicID, userPublicID string) ([]AdminGroupMember, error) {
	if err := requireUserBan(actor); err != nil {
		return nil, err
	}
	now := s.clk.Now()
	var out []AdminGroupMember
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		g, err := s.groupByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		targetID, err := s.userIDByPublicID(ctx, tx, userPublicID)
		if err != nil {
			return err
		}
		already, err := s.repo.IsGroupMember(ctx, tx, g.ID, targetID)
		if err != nil {
			return err
		}
		if already {
			return invalid("user_id", "这个人已经是组成员")
		}
		if err := s.repo.AddGroupMember(ctx, tx, g.ID, targetID, actor.UserID, now); err != nil {
			return err
		}
		rows, err := s.repo.AdminGroupMembers(ctx, tx, g.ID)
		if err != nil {
			return err
		}
		out = adminGroupMemberItems(rows)
		return pgsql.InsertGroupAudit(ctx, tx, actor.UserID, AuditGroupMemberAdd, g.PublicID, map[string]any{
			"after": map[string]any{"user_id": userPublicID},
		}, now)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// AdminRemoveGroupMember 移出组。
func (s *Service) AdminRemoveGroupMember(ctx context.Context, actor *authz.Actor, publicID, userPublicID string) ([]AdminGroupMember, error) {
	if err := requireUserBan(actor); err != nil {
		return nil, err
	}
	var out []AdminGroupMember
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		g, err := s.groupByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		targetID, err := s.userIDByPublicID(ctx, tx, userPublicID)
		if err != nil {
			return err
		}
		n, err := s.repo.RemoveGroupMember(ctx, tx, g.ID, targetID)
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrGroupMemberNotFound
		}
		rows, err := s.repo.AdminGroupMembers(ctx, tx, g.ID)
		if err != nil {
			return err
		}
		out = adminGroupMemberItems(rows)
		return pgsql.InsertGroupAudit(ctx, tx, actor.UserID, AuditGroupMemberRemove, g.PublicID, map[string]any{
			"before": map[string]any{"user_id": userPublicID},
		}, s.clk.Now())
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ── 分区 × 组 ACL 行 ──────────────────────────────────────────────

func adminGroupACLItems(rows []pgsql.AdminGroupACLRow) []AdminGroupACLItem {
	out := make([]AdminGroupACLItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, AdminGroupACLItem{
			GroupKey: r.GroupKey,
			CanPost: r.CanPost, CanReply: r.CanReply, DenyPost: r.DenyPost, DenyReply: r.DenyReply,
		})
	}
	return out
}

// groupACLToMap 把组矩阵写进审计（aclToMap 的组半份）。
func groupACLToMap(rows []pgsql.AdminGroupACLRow) map[string]any {
	m := make(map[string]any, len(rows))
	for _, r := range rows {
		m[r.GroupKey] = map[string]bool{
			"can_post": r.CanPost, "can_reply": r.CanReply,
			"deny_post": r.DenyPost, "deny_reply": r.DenyReply,
		}
	}
	return m
}

// AdminBoardGroupACL 读一个分区的组矩阵。
func (s *Service) AdminBoardGroupACL(ctx context.Context, actor *authz.Actor, publicID string) ([]AdminGroupACLItem, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	id, err := s.boardIDByPublicID(ctx, s.db, publicID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.AdminGroupACL(ctx, s.db, id, false)
	if err != nil {
		return nil, err
	}
	return adminGroupACLItems(rows), nil
}

// ReplaceBoardGroupACL 全量替换分区 × 组矩阵（照 ReplaceBoardACL 的三处不静默）。
func (s *Service) ReplaceBoardGroupACL(ctx context.Context, actor *authz.Actor, publicID string, items []AdminGroupACLItem) ([]AdminGroupACLItem, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for i, it := range items {
		if strings.TrimSpace(it.GroupKey) == "" {
			return nil, invalid("acls", "第 "+itoa64(int64(i+1))+" 行没有 group_key")
		}
		if seen[it.GroupKey] {
			return nil, invalid("acls", "同一个组只能有一行")
		}
		seen[it.GroupKey] = true
		if (it.DenyPost && it.CanPost) || (it.DenyReply && it.CanReply) {
			return nil, invalid("acls", "同一行的「允许」与「禁止」不能同时勾上")
		}
		keys = append(keys, it.GroupKey)
	}
	var out []AdminGroupACLItem
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		boardID, err := s.boardIDByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		if err := pgsql.LockBoard(ctx, tx, boardID); err != nil {
			return err
		}
		if n, err := pgsql.GroupsExistByKey(ctx, tx, keys); err != nil {
			return err
		} else if n != len(keys) {
			return invalid("acls", "有组不存在（可能刚被删掉），请刷新组列表")
		}
		before, err := s.repo.AdminGroupACL(ctx, tx, boardID, true)
		if err != nil {
			return err
		}
		rows := make([]pgsql.AdminGroupACLRow, 0, len(items))
		for _, it := range items {
			rows = append(rows, pgsql.AdminGroupACLRow{
				GroupKey: it.GroupKey, CanPost: it.CanPost, CanReply: it.CanReply,
				DenyPost: it.DenyPost, DenyReply: it.DenyReply,
			})
		}
		if err := pgsql.SetAdminGroupACL(ctx, tx, boardID, rows); err != nil {
			return err
		}
		after, err := s.repo.AdminGroupACL(ctx, tx, boardID, false)
		if err != nil {
			return err
		}
		out = adminGroupACLItems(after)
		return pgsql.InsertGroupAudit(ctx, tx, actor.UserID, AuditBoardGroupACLUpdate, publicID, map[string]any{
			"before": groupACLToMap(before),
			"after":  groupACLToMap(after),
		}, s.clk.Now())
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}