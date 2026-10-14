package pgsql

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// 管理端分区的写路径与 ACL / 版主（交接单 C2）。
// 写一律接收 Querier（事务里就是 *ent.Tx）：事务边界在 service 的 db.WithTx 里，本包不开事务。

const adminACLSQL = `
SELECT a.role_id, r.key, a.can_post, a.can_reply, a.deny_post, a.deny_reply
  FROM board_acls a
  JOIN roles r ON r.id = a.role_id
 WHERE a.board_id = $1
 ORDER BY r.priority, r.id`

// 替换前的读必须锁住这些行：两个管理员同时保存同一张矩阵时，后写的赢（全量替换语义），
// 而没有锁的话「读旧值 → 写审计 → 删光 → 重插」会交错成一句说不出 what happened 的审计。
const adminACLLockedSQL = adminACLSQL + `
   FOR UPDATE OF a`

// AdminACLRow 是一行 ACL 象限。role_id 是**自增 id**：矩阵的键就是角色，
// 而 /admin/roles 的 RoleItem.id 也是自增 id，两侧对得上。
type AdminACLRow struct {
	RoleID    int64  `json:"role_id"`
	RoleKey   string `json:"role_key"`
	CanPost   bool   `json:"can_post"`
	CanReply  bool   `json:"can_reply"`
	DenyPost  bool   `json:"deny_post"`
	DenyReply bool   `json:"deny_reply"`
}

// AdminACL 读分区 ACL。lock=true 时加 FOR UPDATE。
func (s *Store) AdminACL(ctx context.Context, q Querier, boardID int64, lock bool) ([]AdminACLRow, error) {
	sqlText := adminACLSQL
	if lock {
		sqlText = adminACLLockedSQL
	}
	var out []AdminACLRow
	err := queryQ(ctx, q, sqlText, []any{boardID}, func(rows *sql.Rows) error {
		var a AdminACLRow
		if err := rows.Scan(&a.RoleID, &a.RoleKey, &a.CanPost, &a.CanReply, &a.DenyPost, &a.DenyReply); err != nil {
			return err
		}
		out = append(out, a)
		return nil
	})
	return out, err
}

// LockBoard 锁住一个分区行（FOR UPDATE）。ACL 替换前先拿它：
// 两个管理员同时保存同一张矩阵时串行化，后保存的赢（全量替换语义）。
// 锁 boards 而不是 board_acls 的行：新分区一行 ACL 都没有，没有行可锁。
func LockBoard(ctx context.Context, tx Querier, boardID int64) error {
	return exec(ctx, tx, "SELECT id FROM boards WHERE id = $1 FOR UPDATE", boardID)
}

// SetAdminACL 全量替换一个分区的 ACL 矩阵：先清空，再逐行插入。

//
// **整体替换**是设计定的语义（界面需求 §5.3）：矩阵是一个整体，逐格 PATCH 会把「禁止优先」的
// 中间态暴露给正在发帖的用户（一个角色可能短暂地既不在 can 里也不在 deny 里）。
// DB 的 ck_board_acls_no_contradiction 兜住「同一行既 can 又 deny」，但 service 先判一次 ——
// 约束报错说不出是哪个角色的哪一格，而前端要把错误挂到那个格子上。
func SetAdminACL(ctx context.Context, tx Querier, boardID int64, rows []AdminACLRow) error {
	if err := exec(ctx, tx, "DELETE FROM board_acls WHERE board_id = $1", boardID); err != nil {
		return err
	}
	for _, a := range rows {
		if err := exec(ctx, tx, `
INSERT INTO board_acls (board_id, role_id, can_post, can_reply, deny_post, deny_reply, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
			boardID, a.RoleID, a.CanPost, a.CanReply, a.DenyPost, a.DenyReply); err != nil {
			return err
		}
	}
	return nil
}

// RolesExist 确认这些 role_id 都真实存在（前端传了不存在的 id 要 400 而不是静默少一行）。
func RolesExist(ctx context.Context, q Querier, roleIDs []int64) (int, error) {
	if len(roleIDs) == 0 {
		return 0, nil
	}
	var n int
	err := queryOneQ(ctx, q, "SELECT count(*) FROM roles WHERE id = ANY($1::bigint[])", []any{roleIDs},
		func(rows *sql.Rows) error { return rows.Scan(&n) })
	return n, err
}

// ── 版主任期（board_moderators） ──────────────────────────────────

// AdminModeratorRow 是一行任期（含已卸任的：后台要看历史）。
type AdminModeratorRow struct {
	ID        int64
	UserID    string
	Handle    string
	Nickname  string
	GrantedAt time.Time
	ExpiresAt *time.Time
	GrownAt   *time.Time
}

const adminModeratorsSQL = `
SELECT m.id, u.public_id::text, u.username,
       coalesce(nullif(u.nickname, ''), u.username),
       m.granted_at, m.expires_at, m.grown_at
  FROM board_moderators m
  JOIN users u ON u.id = m.user_id
 WHERE m.board_id = $1
 ORDER BY (m.grown_at IS NULL) DESC, m.granted_at DESC, m.id DESC`

// AdminModerators 列出该分区的全部任期（在任的在前）。
func (s *Store) AdminModerators(ctx context.Context, q Querier, boardID int64) ([]AdminModeratorRow, error) {
	var out []AdminModeratorRow
	err := queryQ(ctx, q, adminModeratorsSQL, []any{boardID}, func(rows *sql.Rows) error {
		var m AdminModeratorRow
		var expires, grown sql.NullTime
		if err := rows.Scan(&m.ID, &m.UserID, &m.Handle, &m.Nickname, &m.GrantedAt, &expires, &grown); err != nil {
			return err
		}
		m.ExpiresAt = scanNullTime(expires)
		m.GrownAt = scanNullTime(grown)
		out = append(out, m)
		return nil
	})
	return out, err
}

// UpsertAdminModerator 任命一个版主（幂等）。
//
// ON CONFLICT 必须写成带谓词的形式去命中**部分**唯一索引 uq_board_moderators_active：
// 不带谓词在部分索引上会报「没有匹配 ON CONFLICT 的约束」。
// 重复任命 = 改任期与任命人（管理员的意图是「把这个设成这样」），不是 409。
func UpsertAdminModerator(ctx context.Context, tx Querier, boardID, userID, granterID int64, expiresAt *time.Time, now time.Time) error {
	return exec(ctx, tx, `
INSERT INTO board_moderators (board_id, user_id, granted_by, granted_at, expires_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (board_id, user_id) WHERE grown_at IS NULL
DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at`,
		boardID, userID, granterID, now, expiresAt)
}

// RevokeAdminModerator 免掉一个版主：置 grown_at（**不删行**：删了就答不出「谁什么时候被免的」）。
// 返回受影响行数：0 = 这个人本来就不在任（路由回 404，不是「操作成功」）。
func RevokeAdminModerator(ctx context.Context, tx Querier, boardID, userID int64, now time.Time) (int64, error) {
	return rowsAffected(ctx, tx,
		"UPDATE board_moderators SET grown_at = $3 WHERE board_id = $1 AND user_id = $2 AND grown_at IS NULL",
		boardID, userID, now)
}

// BoardIDsByPublicID 取全部分区的 (public_id → id)。
//
// 需要它是因为 ent 的 Board 实体里**没有 public_id**（迁移 0025 才加的那一列，
// 不重新生成 ent 代码：管理端的读路径本来就全走本域 pgsql）。
// 重排要按请求给的对外顺序映射回自增 id，所以要一次拿全。
func BoardIDsByPublicID(ctx context.Context, q Querier) (map[string]int64, error) {
	out := map[string]int64{}
	err := queryQ(ctx, q, "SELECT public_id::text, id FROM boards", nil, func(rows *sql.Rows) error {
		var public string
		var id int64
		if err := rows.Scan(&public, &id); err != nil {
			return err
		}
		out[public] = id
		return nil
	})
	return out, err
}

// InsertBoardAudit 写一条分区管理的审计。
//
// **不复用 InsertReviewAudit**：那条把 target_type 写死成 'topic'（它是为审核判定写的），
// 拿它写分区审计会让审计屏把「改分区 ACL」显示成「判了一篇帖子」。
// detail 在这里 marshal：调用方给 map，落库是 jsonb。
func InsertBoardAudit(ctx context.Context, tx Querier, actorID int64, action, targetID string,
	detail map[string]any, now time.Time) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	return exec(ctx, tx,
		"INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at) "+
			"VALUES ($1, $2, 'board', $3, $4::jsonb, $5)",
		actorID, action, targetID, string(raw), now.UTC())
}

// CountActiveModerators 数在任的版主（任命时的上限校验）。
func CountActiveModerators(ctx context.Context, q Querier, boardID int64) (int, error) {
	var n int
	err := queryOneQ(ctx, q,
		"SELECT count(*) FROM board_moderators WHERE board_id = $1 AND grown_at IS NULL",
		[]any{boardID}, func(rows *sql.Rows) error { return rows.Scan(&n) })
	return n, err
}

// ReorderBoards 按给定顺序重写 sort（1..n）。整表一条语句：逐条 UPDATE 会留下半截顺序。

func ReorderBoards(ctx context.Context, tx Querier, ids []int64) (int64, error) {
	return rowsAffected(ctx, tx, `
UPDATE boards b SET sort = v.ord, updated_at = now()
  FROM (SELECT id, ord FROM unnest($1::bigint[]) WITH ORDINALITY AS t(id, ord)) v
 WHERE b.id = v.id`, ids)
}
