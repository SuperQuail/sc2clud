// Package pgsql 放本域 ent 表达不了的原生 SQL（方案 §15.7：原生 SQL 只出现在 platform 层、
// 手写迁移与业务模块自己的 pgsql 子包）。它不是抽象层，就是几个 const + 几个函数。
//
// 三条查询在这里：会话解析（JOIN board_moderators 的 LATERAL）、权限闭包（WITH RECURSIVE）、
// 登录定位（lower(col) = lower($1) 与表达式索引逐字一致）。其余全部走 ent。
//
// 走 database/sql 而不是 pgx 的 Rows：*ent.Client 与 *ent.Tx 都提供 QueryContext / ExecContext，
// 同一个函数因此能在事务内外复用，不需要为「在事务里跑同一条 SQL」再造一套接口。
package pgsql

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"forum/internal/platform/idgen"
)

// Querier 是执行原生查询需要的最小接口：*ent.Client 与 *ent.Tx 都满足它。
// 只有 QueryContext 与 ExecContext 两个方法——ent 没有 QueryRowContext，
// 所以单行查询走下面这个 QueryRow 帮助函数，别在每个调用点各写一遍。
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Row 只需要一个 Scan：*sql.Row 与 rowScanner 都满足它。
type Row interface {
	Scan(dest ...any) error
}

// QueryRow 是 QueryRowContext 的等价物，用 QueryContext 实现（ent 只给后者）。
// 返回值必须 .Scan() 一次，Scan 会关掉底层的 Rows。
func QueryRow(ctx context.Context, q Querier, query string, args ...any) Row {
	rows, err := q.QueryContext(ctx, query, args...)
	return rowScanner{rows: rows, err: err}
}

type rowScanner struct {
	rows *sql.Rows
	err  error
}

func (r rowScanner) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	defer r.rows.Close()
	if !r.rows.Next() {
		if err := r.rows.Err(); err != nil {
			return err
		}
		return sql.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

// scanUUID 把 uuid 列读成字符串。pgx 的 database/sql 接口不认 *string → uuid 的扫描，
// 它只认它自己的类型；统一的转换放这里，别在每个 Scan 里各写一遍。
func scanUUID(dst *string) any {
	var u pgtype.UUID
	return &uuidScanner{dst: dst, u: &u}
}

type uuidScanner struct {
	dst *string
	u   *pgtype.UUID
}

var _ [16]byte = pgtype.UUID{}.Bytes

func (s *uuidScanner) Scan(v any) error {
	if err := s.u.Scan(v); err != nil {
		return err
	}
	if !s.u.Valid {
		*s.dst = ""
		return nil
	}
	*s.dst = uuidString(s.u.Bytes)
	return nil
}

func uuidString(b [16]byte) string {
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// 断言 pgtype 的 UUID 就是 16 字节数组：pgx 的 codec 变了这里会编译失败，而不是悄悄写错 ID。

// ────────────────────────────────────────────────────────────
// 会话解析：走 uq_sessions_token + users_pkey + roles_pkey + idx_board_moderators_user 四条 Index Scan
// ────────────────────────────────────────────────────────────

const ResolveSessionSQL = `
SELECT s.token_hash, s.csrf_token, s.expires_at, s.id AS session_id,
       u.id AS user_id, u.public_id, u.username, u.nickname, u.status,
       u.email_verified_at, u.activated_at, u.avatar_hash, u.avatar_small_hash,
       r.id AS role_id, r.key AS role_key, r.name AS role_name,
       r.badge_color AS role_badge, r.is_super,
       COALESCE(bm.board_ids, '{}'::bigint[]) AS board_ids
  FROM sessions s
  JOIN users u        ON u.id = s.user_id
  JOIN roles r        ON r.id = u.role_id
  LEFT JOIN LATERAL (
        SELECT array_agg(m.board_id ORDER BY m.board_id) AS board_ids
          FROM board_moderators m
         WHERE m.user_id = u.id
           AND (m.expires_at IS NULL OR m.expires_at > $2)
       ) bm ON true
 WHERE s.token_hash = $1
   AND s.expires_at > $2`

// SessionRow 是会话解析的结果。权限**不在这里**：一条会话只回答「你是谁」，
// 「你能不能」由 LoadActor 单独算（设计 §8.3 的两条独立查询）。
type SessionRow struct {
	TokenHash     []byte
	CSRF          string
	ExpiresAt     time.Time
	SessionID     int64
	UserID        int64
	PublicID      string
	Username      string
	Nickname      string
	Status        string
	EmailVerified *time.Time
	ActivatedAt   *time.Time
	AvatarHash    *string
	AvatarSmall   *string
	RoleID        int64
	RoleKey       string
	RoleName      string
	RoleBadge     *string
	IsSuper       bool
	BoardIDs      []int64
}

// ResolveSession 按 token 摘要查会话。$2 是 clock.Now()，不是 PG 的 now()：
// 会话过期是业务时间，必须能被 clock.Fake 控制（方案 §14.7）。
func ResolveSession(ctx context.Context, q Querier, digest []byte, now time.Time) (*SessionRow, error) {
	var r SessionRow
	row := QueryRow(ctx, q, ResolveSessionSQL, digest, now)
	err := row.Scan(
		&r.TokenHash, &r.CSRF, &r.ExpiresAt, &r.SessionID,
		&r.UserID, scanUUID(&r.PublicID), &r.Username, &r.Nickname, &r.Status,
		&r.EmailVerified, &r.ActivatedAt, &r.AvatarHash, &r.AvatarSmall,
		&r.RoleID, &r.RoleKey, &r.RoleName, &r.RoleBadge, &r.IsSuper, &r.BoardIDs,
	)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ────────────────────────────────────────────────────────────
// 权限闭包：角色链上的勾选 ∪ 未过期的点对点追加（拍板 §1.4 / U8 读时闭包）
// ────────────────────────────────────────────────────────────

const LoadActorSQL = `
WITH RECURSIVE chain AS (
        SELECT r.id, r.parent_id, r.is_super FROM roles r WHERE r.id = $1
  UNION ALL
        SELECT p.id, p.parent_id, p.is_super
          FROM roles p JOIN chain c ON p.id = c.parent_id
),
perms AS (
        SELECT DISTINCT rp.permission_id
          FROM role_permissions rp
          JOIN chain c ON c.id = rp.role_id
  UNION
        SELECT up.permission_id
          FROM user_permissions up
         WHERE up.user_id = $2
           AND (up.expires_at IS NULL OR up.expires_at > $3)
)
SELECT u.id, u.public_id, u.status, u.email_verified_at, u.activated_at,
       r.id, r.key, r.name, r.badge_color, r.is_super,
       COALESCE((SELECT array_agg(p.key ORDER BY p.key)
                   FROM perms x JOIN permissions p ON p.id = x.permission_id), '{}'::text[]) AS perm_keys,
       COALESCE((SELECT array_agg(m.board_id ORDER BY m.board_id)
                   FROM board_moderators m
                  WHERE m.user_id = u.id AND (m.expires_at IS NULL OR m.expires_at > $3)), '{}'::bigint[]) AS board_ids,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('key', p.key, 'expires_at', up.expires_at) ORDER BY p.key)
                   FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
                  WHERE up.user_id = u.id AND (up.expires_at IS NULL OR up.expires_at > $3)), '[]'::jsonb) AS extra
  FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE u.id = $2`

// ExtraPerm 是一条点对点追加的权限。
type ExtraPerm struct {
	Key       string     `json:"key"`
	ExpiresAt *time.Time `json:"expires_at"`
}

// ActorRow 是 LoadActor 的结果。
type ActorRow struct {
	UserID        int64
	PublicID      string
	Status        string
	EmailVerified *time.Time
	ActivatedAt   *time.Time
	RoleID        int64
	RoleKey       string
	RoleName      string
	RoleBadge     *string
	IsSuper       bool
	PermKeys      []string
	BoardIDs      []int64
	Extra         []ExtraPerm
}

// LoadActor 算一个人的有效权限集合。$1 = role_id，$2 = user_id，$3 = clock.Now()。
// EXPLAIN 预期：users_pkey → roles_pkey → role_permissions_pkey（≤24 行）→ idx_user_permissions_permission
// → idx_board_moderators_user → permissions_pkey；roles / permissions 是常数级表，代价与用户数无关。
func LoadActor(ctx context.Context, q Querier, roleID, userID int64, now time.Time) (*ActorRow, error) {
	var r ActorRow
	var extra []byte
	err := QueryRow(ctx, q, LoadActorSQL, roleID, userID, now).Scan(
		&r.UserID, scanUUID(&r.PublicID), &r.Status, &r.EmailVerified, &r.ActivatedAt,
		&r.RoleID, &r.RoleKey, &r.RoleName, &r.RoleBadge, &r.IsSuper,
		&r.PermKeys, &r.BoardIDs, &extra,
	)
	if err != nil {
		return nil, err
	}
	if len(extra) > 0 {
		if err := json.Unmarshal(extra, &r.Extra); err != nil {
			return nil, fmt.Errorf("pgsql: 解析 extra: %w", err)
		}
	}
	return &r, nil
}

// ────────────────────────────────────────────────────────────
// 登录定位：username 或 email，大小写不敏感
// ────────────────────────────────────────────────────────────

// FindUserByLoginSQL 的谓词必须写成 lower(u.username) = lower($1)：
// 与 uq_users_username_lower / uq_users_email_lower 的表达式逐字一致，否则退化成 Seq Scan
// （拍板 §5.9 第 2 条 / 设计 §11.3）。LIMIT 2 是 U17 的落点：不交叉判占用，
// 万一同一个串既是 A 的 username 又是 B 的 email，按 id 取第一个。
const FindUserByLoginSQL = `
SELECT u.id, u.public_id, u.username, u.email, u.password_hash, u.nickname,
       u.status, u.email_verified_at, u.activated_at, u.trusted,
       u.avatar_hash, u.avatar_small_hash,
       u.role_id, r.key AS role_key, r.is_super
  FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE lower(u.username) = lower($1)
    OR lower(u.email)    = lower($1)
 ORDER BY u.id
 LIMIT 2`

// LoginRow 是登录定位的结果。
type LoginRow struct {
	ID              int64
	PublicID        string
	Username        string
	Email           string
	PasswordHash    string
	Nickname        string
	Status          string
	EmailVerifiedAt *time.Time
	ActivatedAt     *time.Time
	Trusted         bool
	AvatarHash      *string
	AvatarSmall     *string
	RoleID          int64
	RoleKey         string
	IsSuper         bool
}

// FindUserByLogin 返回 (row, found)。查不到时 found=false 且 err=nil——
// 「这个登录名存不存在」是登录与找回密码的正常分支，不是错误。
func FindUserByLogin(ctx context.Context, q Querier, login string) (*LoginRow, bool, error) {
	var r LoginRow
	err := QueryRow(ctx, q, FindUserByLoginSQL, login).Scan(
		&r.ID, scanUUID(&r.PublicID), &r.Username, &r.Email, &r.PasswordHash, &r.Nickname,
		&r.Status, &r.EmailVerifiedAt, &r.ActivatedAt, &r.Trusted,
		&r.AvatarHash, &r.AvatarSmall,
		&r.RoleID, &r.RoleKey, &r.IsSuper,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, false, nil
		}
		return nil, false, err
	}
	return &r, true, nil
}

// ────────────────────────────────────────────────────────────
// 审计：多态三筛选 + actor + 时间窗 + 游标
// ────────────────────────────────────────────────────────────

const ListAuditSQL = `
SELECT a.id, a.created_at, a.action, a.target_type, a.target_id, a.detail, a.ip,
       u.public_id, u.username, u.nickname
  FROM audit_logs a
  LEFT JOIN users u ON u.id = a.actor_id
 WHERE ($1::text        IS NULL OR a.target_type = $1)
   AND ($2::text        IS NULL OR a.target_id   = $2)
   AND ($3::text        IS NULL OR a.action      = $3)
   AND ($4::bigint      IS NULL OR a.actor_id    = $4)
   AND ($5::timestamptz IS NULL OR a.created_at >= $5)
   AND ($6::timestamptz IS NULL OR a.created_at <  $6)
   AND ($7::timestamptz IS NULL OR (a.created_at, a.id) < ($7, $8))
 ORDER BY a.created_at DESC, a.id DESC
 LIMIT $9`

// AuditRow 是一条审计流水（连操作者的展示字段一起取回，省一次往返）。
type AuditRow struct {
	ID            int64
	CreatedAt     time.Time
	Action        string
	TargetType    string
	TargetID      string
	Detail        map[string]any
	IP            *netip.Addr
	ActorPublicID *string
	ActorHandle   *string
	ActorNickname *string
}

// AuditFilter 是审计查询的筛选条件。零值表示不筛。
type AuditFilter struct {
	TargetType string
	TargetID   string
	Action     string
	ActorID    *int64
	From       *time.Time
	To         *time.Time
	CursorAt   *time.Time
	CursorID   int64
	Limit      int
}

// ListAudit 按筛选取一页。所有筛选项都是**参数**，没有一处拼用户输入（方案 §15.8）。
func ListAudit(ctx context.Context, q Querier, f AuditFilter) ([]AuditRow, error) {
	rows, err := q.QueryContext(ctx, ListAuditSQL,
		nullText(f.TargetType), nullText(f.TargetID), nullText(f.Action),
		f.ActorID, f.From, f.To, f.CursorAt, f.CursorID, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AuditRow
	for rows.Next() {
		var r AuditRow
		var pub *string
		if err := rows.Scan(&r.ID, &r.CreatedAt, &r.Action, &r.TargetType, &r.TargetID,
			&r.Detail, &r.IP, &pub, &r.ActorHandle, &r.ActorNickname); err != nil {
			return nil, err
		}
		r.ActorPublicID = pub
		out = append(out, r)
	}
	return out, rows.Err()
}

// nullText 把空串变成 SQL NULL：这样 ($1 IS NULL OR col = $1) 才能跳过该筛选项。
func nullText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var _ = idgen.ParsePublicID
