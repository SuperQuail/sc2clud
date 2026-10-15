package pgsql

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// 用户组（D38）：组目录 / 组员名单 / 分区 × 组 ACL 行。全部原生 SQL —— ent 没有这三张表的实体
//（不重新生成 ent 代码：0050 补 boards.public_id 时的同一条先例）。
// 写路径一律接 Querier（事务里就是 *ent.Tx），事务边界在 service。

// AdminGroupRow 是组目录的一行（member_count 现算：组是几十个的小表，子查询够了）。
type AdminGroupRow struct {
	ID          int64
	PublicID    string
	Key         string
	Name        string
	Description string
	MemberCount int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const adminGroupCols = `g.id, g.public_id::text, g.key, g.name, g.description,
       (SELECT count(*) FROM user_group_members m WHERE m.group_id = g.id),
       g.created_at, g.updated_at`

// AdminGroups 是组目录（升序按 key；组是几十个的小表，不翻页）。
func (s *Store) AdminGroups(ctx context.Context, q Querier) ([]AdminGroupRow, error) {
	var out []AdminGroupRow
	err := queryQ(ctx, q, "SELECT "+adminGroupCols+" FROM user_groups g ORDER BY g.key, g.id", nil,
		func(rows *sql.Rows) error { return scanAdminGroup(rows, &out) })
	return out, err
}

// AdminGroupByPublicID 取一个组（管理端写路径的回执与不存在判定共用）。
func (s *Store) AdminGroupByPublicID(ctx context.Context, q Querier, publicID string) (*AdminGroupRow, error) {
	var out []AdminGroupRow
	err := queryOneQ(ctx, q, "SELECT "+adminGroupCols+" FROM user_groups g WHERE g.public_id = $1", []any{publicID},
		func(rows *sql.Rows) error { return scanAdminGroup(rows, &out) })
	if err != nil {
		return nil, err
	}
	return &out[0], nil
}

func scanAdminGroup(rows *sql.Rows, out *[]AdminGroupRow) error {
	var g AdminGroupRow
	if err := rows.Scan(&g.ID, &g.PublicID, &g.Key, &g.Name, &g.Description, &g.MemberCount,
		&g.CreatedAt, &g.UpdatedAt); err != nil {
		return err
	}
	*out = append(*out, g)
	return nil
}

// InsertAdminGroup 建组（key 由调用方校验过；public_id 走 DEFAULT gen_random_uuid()）。
func InsertAdminGroup(ctx context.Context, q Querier, key, name, description string,
	actorID int64, now time.Time) (int64, string, error) {
	var id int64
	var pub string
	err := QueryRow(ctx, q, "INSERT INTO user_groups (key, name, description, created_by, updated_by, created_at, updated_at)"+
		" VALUES ($1, $2, $3, $4, $4, $5, $5) RETURNING id, public_id::text",
		key, name, description, actorID, now).Scan(&id, &pub)
	return id, pub, err
}

// UpdateAdminGroup 改组：key 建后不可改（boards.slug 同一条纪律），入参里就没有它。
func UpdateAdminGroup(ctx context.Context, q Querier, groupID int64, name, description string,
	actorID int64, now time.Time) error {
	return exec(ctx, q,
		"UPDATE user_groups SET name = $1, description = $2, updated_by = $3, updated_at = $4 WHERE id = $5",
		name, description, actorID, now, groupID)
}

// DeleteAdminGroup 删组（members 与 board_group_acls 随 CASCADE；受影响行数给 404 判定）。
func DeleteAdminGroup(ctx context.Context, q Querier, groupID int64) (int64, error) {
	return rowsAffected(ctx, q, "DELETE FROM user_groups WHERE id = $1", groupID)
}

// GroupsExist 是分组矩阵 PUT 前的前置（照 RolesExist）。
func GroupsExist(ctx context.Context, q Querier, groupIDs []int64) (int, error) {
	if len(groupIDs) == 0 {
		return 0, nil
	}
	var n int
	err := queryOneQ(ctx, q, "SELECT count(*) FROM user_groups WHERE id = ANY($1::bigint[])", []any{groupIDs},
		func(rows *sql.Rows) error { return rows.Scan(&n) })
	return n, err
}

// ── 组员 ─────────────────────────────────────────────────────────

// AdminGroupMemberRow 是组员名单的一行（最近入组的在前）。
type AdminGroupMemberRow struct {
	UserID   string
	Handle   string
	Nickname string
	AddedAt  time.Time
}

const adminGroupMembersSQL = `
SELECT u.public_id::text, u.username, coalesce(nullif(u.nickname, ''), u.username), m.added_at
  FROM user_group_members m
  JOIN users u ON u.id = m.user_id
 WHERE m.group_id = $1
 ORDER BY m.added_at DESC, m.id DESC`

// AdminGroupMembers 列出该组的全部成员。
func (s *Store) AdminGroupMembers(ctx context.Context, q Querier, groupID int64) ([]AdminGroupMemberRow, error) {
	var out []AdminGroupMemberRow
	err := queryQ(ctx, q, adminGroupMembersSQL, []any{groupID}, func(rows *sql.Rows) error {
		var m AdminGroupMemberRow
		if err := rows.Scan(&m.UserID, &m.Handle, &m.Nickname, &m.AddedAt); err != nil {
			return err
		}
		out = append(out, m)
		return nil
	})
	return out, err
}

// IsGroupMember 问名单上有没有这个人（重复入组走 400 挂到 user_id，不静默）。
func (s *Store) IsGroupMember(ctx context.Context, q Querier, groupID, userID int64) (bool, error) {
	var ok bool
	err := queryOneQ(ctx, q,
		"SELECT EXISTS (SELECT 1 FROM user_group_members WHERE group_id = $1 AND user_id = $2)",
		[]any{groupID, userID}, func(rows *sql.Rows) error { return rows.Scan(&ok) })
	return ok, err
}

// AddGroupMember 拉人入组。
func (s *Store) AddGroupMember(ctx context.Context, q Querier, groupID, userID, actorID int64, now time.Time) error {
	return exec(ctx, q,
		"INSERT INTO user_group_members (group_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4)",
		groupID, userID, actorID, now)
}

// RemoveGroupMember 移出组（返回受影响行数：0 = 这个人本来就不在）。
func (s *Store) RemoveGroupMember(ctx context.Context, q Querier, groupID, userID int64) (int64, error) {
	return rowsAffected(ctx, q,
		"DELETE FROM user_group_members WHERE group_id = $1 AND user_id = $2", groupID, userID)
}

// ── 分区 × 组 ACL 行（照 admin_boards_write.go 的矩阵那一组） ────────────

const adminGroupACLSQL = `
SELECT a.group_id, gg.key, a.can_post, a.can_reply, a.deny_post, a.deny_reply
  FROM board_group_acls a
  JOIN user_groups gg ON gg.id = a.group_id
 WHERE a.board_id = $1
 ORDER BY gg.key, gg.id`

// AdminGroupACLRow 是一行分区 × 组的 ACL（形状照 AdminACLRow，键从 role 换成 group）。
type AdminGroupACLRow struct {
	GroupID   int64  `json:"group_id"`
	GroupKey  string `json:"group_key"`
	CanPost   bool   `json:"can_post"`
	CanReply  bool   `json:"can_reply"`
	DenyPost  bool   `json:"deny_post"`
	DenyReply bool   `json:"deny_reply"`
}

// AdminGroupACL 读分区的组矩阵。lock=true 时加 FOR UPDATE（全量替换前的读要锁）。
func (s *Store) AdminGroupACL(ctx context.Context, q Querier, boardID int64, lock bool) ([]AdminGroupACLRow, error) {
	sqlText := adminGroupACLSQL
	if lock {
		sqlText = adminGroupACLSQL + " FOR UPDATE OF a"
	}
	var out []AdminGroupACLRow
	err := queryQ(ctx, q, sqlText, []any{boardID}, func(rows *sql.Rows) error {
		var a AdminGroupACLRow
		if err := rows.Scan(&a.GroupID, &a.GroupKey, &a.CanPost, &a.CanReply, &a.DenyPost, &a.DenyReply); err != nil {
			return err
		}
		out = append(out, a)
		return nil
	})
	return out, err
}

// SetAdminGroupACL 全量替换一个分区的组矩阵（整体替换语义照 board_acls）。
func SetAdminGroupACL(ctx context.Context, q Querier, boardID int64, rows []AdminGroupACLRow) error {
	if err := exec(ctx, q, "DELETE FROM board_group_acls WHERE board_id = $1", boardID); err != nil {
		return err
	}
	for _, a := range rows {
		if err := exec(ctx, q, `
INSERT INTO board_group_acls (board_id, group_id, can_post, can_reply, deny_post, deny_reply, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
			boardID, a.GroupID, a.CanPost, a.CanReply, a.DenyPost, a.DenyReply); err != nil {
			return err
		}
	}
	return nil
}

// InsertGroupAudit 写一条用户组审计（target_type = user_group；不复用 InsertBoardAudit ——
// 它把 target_type 写死成 'board'，与 InsertReviewAudit/InsertBoardAudit 各持各的同一理由）。
func InsertGroupAudit(ctx context.Context, q Querier, actorID int64, action, targetID string,
	detail map[string]any, now time.Time) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	return exec(ctx, q,
		"INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at) "+
			"VALUES ($1, $2, 'user_group', $3, $4::jsonb, $5)",
		actorID, action, targetID, string(raw), now.UTC())
}