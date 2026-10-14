package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// ACLRow 是发言权判定需要的全部事实（d3-forum §6.1 的一条查询、四张表、四个索引）。
//
// **没有第五支**：「我这个角色有没有 topic.create」已经在 actor.Perms 上
// （D2 的装配查询一次取回），再查 role_permissions 就是第二份真源。
type ACLRow struct {
	BoardID       int64
	BoardStatus   string
	ACLEnabled    bool
	MinPostLevel  int
	HasRoleRow    bool
	CanPost       bool
	CanReply      bool
	DenyPost      bool
	DenyReply     bool
	HasSanction   bool
	SanctionUntil *time.Time
	SanctionPerm  bool // until IS NULL 的那条：永久禁言
	IsModerator   bool
}

func (r ACLRow) Can(action string) bool {
	if action == "post" {
		return r.CanPost
	}
	return r.CanReply
}

func (r ACLRow) Deny(action string) bool {
	if action == "post" {
		return r.DenyPost
	}
	return r.DenyReply
}

// ACLRowFor 一次拿全 ACL 判定的四个事实（§6.1）。
// action 是 post | reply，只影响 sanction 那一支（sa.action IN ($4, all)）。
func (s *Store) ACLRowFor(ctx context.Context, boardID, roleID, userID int64, action string, now time.Time) (*ACLRow, error) {
	var r ACLRow
	var until sql.NullTime
	var hit, permanent sql.NullBool
	var err = s.queryOne(ctx, sqlJoin(
		"SELECT b.id, b.status, b.acl_enabled, b.min_post_level,",
		"       COALESCE(acl.can_post,   false),",
		"       COALESCE(acl.can_reply,  false),",
		"       COALESCE(acl.deny_post,  false),",
		"       COALESCE(acl.deny_reply, false),",
		"       (acl.role_id IS NOT NULL),",
		"       s.hit, s.permanent, s.until,",
		"       EXISTS (SELECT 1 FROM board_moderators m WHERE m.board_id = b.id AND m.user_id = $3)",
		"  FROM boards b",
		"  LEFT JOIN board_acls acl ON acl.board_id = b.id AND acl.role_id = $2",
		"  LEFT JOIN LATERAL (",
		"    SELECT count(*) > 0              AS hit,",
		"           bool_or(sa.until IS NULL) AS permanent,",
		"           min(sa.until)             AS until",
		"      FROM sanctions sa",
		"     WHERE sa.user_id = $3",
		"       AND (sa.board_id IS NULL OR sa.board_id = b.id)",
		"       AND sa.action IN ($4, 'all')",
		"       AND (sa.until IS NULL OR sa.until > $5)",
		"  ) s ON true",
		" WHERE b.id = $1 AND b.status = 'active'",
	), []any{boardID, roleID, userID, action, now.UTC()}, func(rows *sql.Rows) error {
		if err := rows.Scan(&r.BoardID, &r.BoardStatus, &r.ACLEnabled, &r.MinPostLevel,
			&r.CanPost, &r.CanReply, &r.DenyPost, &r.DenyReply, &r.HasRoleRow,
			&hit, &permanent, &until, &r.IsModerator); err != nil {
			return err
		}
		r.HasSanction = hit.Valid && hit.Bool
		r.SanctionUntil = scanNullTime(until)
		r.SanctionPerm = permanent.Valid && permanent.Bool
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// UserLevel 是发帖门槛要的那一个数（§6.4）。等级公式的唯一实现在 D4，本域只读。
func (s *Store) UserLevel(ctx context.Context, userID int64) (int, error) {
	var level int
	err := s.queryOne(ctx, "SELECT level FROM users WHERE id = $1", []any{userID},
		func(rows *sql.Rows) error { return rows.Scan(&level) })
	return level, err
}

// UserBriefByHandle 是 ?author=<handle> 的解引用（走 uq_users_username_lower 表达式索引）。
func (s *Store) UserBriefByHandle(ctx context.Context, handle string) (*UserRow, error) {
	var r UserRow
	var avatar, avatarSmall sql.NullString
	err := s.queryOne(ctx,
		"SELECT id, public_id, username, COALESCE(NULLIF(nickname, ''), username), COALESCE(NULLIF(avatar_hash, ''), default_avatar_hash, ''), COALESCE(NULLIF(avatar_small_hash, ''), NULLIF(avatar_hash, ''), default_avatar_hash, ''), status"+
			" FROM users WHERE lower(username) = lower($1)",
		[]any{handle}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.PublicID, &r.Handle, &r.Nickname, &avatar, &avatarSmall, &r.Status)
		})
	if err != nil {
		return nil, err
	}
	r.AvatarHash = scanNullString(avatar)
	r.AvatarSmall = scanNullString(avatarSmall)
	return &r, nil
}

// UserAuthBrief 是发帖门槛与审核豁免要的两个字段（§4.2 的 review_state 判定）。
func (s *Store) UserAuthBrief(ctx context.Context, userID int64) (*UserAuthBriefRow, error) {
	var r UserAuthBriefRow
	err := s.queryOne(ctx, "SELECT id, trusted, level, status FROM users WHERE id = $1", []any{userID},
		func(rows *sql.Rows) error { return rows.Scan(&r.ID, &r.Trusted, &r.Level, &r.Status) })
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// UserAuthBriefRow 与 forum.UserAuthBrief 字段一致（本包不 import 上层，避免循环）。
type UserAuthBriefRow struct {
	ID      int64
	Trusted bool
	Level   int
	Status  string
}
