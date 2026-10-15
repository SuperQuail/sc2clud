package pgsql

import (
	"context"
	"database/sql"
	"math"
	"strings"
	"time"
)

// 管理端用户读路径（交接单 C1）。三条查询 + 一条批量计数。
//
// 为什么要在这里而不是 ent：列表要按三根状态轴的 NULL 判定 + 三列 ILIKE + 角色 key 过滤，
// 而「按 id DESC 的键集游标」与「一次取回一页的内容计数」都要写成一条 SQL，
// 用 ent 拼出来会变成三四次往返（N+1）。

// AdminUsersFilter 是用户列表的筛选。零值表示不筛。
type AdminUsersFilter struct {
	Q             string
	Status        string
	RoleKey       string
	Activated     *bool
	EmailVerified *bool
	// AfterID 是键集游标：只取 id 严格小于它的行。**0 = 第一页**，
	// 这里换成 MaxInt64 静默换掉 —— 留着 0 会让 `u.id < 0` 恒假，
	// 第一页无声返回空列表（这类「查询恒空但没有任何报错」最难查）。
	AfterID int64
	Limit   int
}

// 筛选写成「参数 IS NULL 就跳过」而不是拼 SQL 串：方案 §15.8 禁止拼接用户输入。
// 顺序说明：
//   - role 用 EXISTS 子查询而不是 JOIN roles：JOIN 之后再按 r.key 过滤也能跑，
//     但那样 users 与 roles 的行都要进哈希，EXISTS 走 uq_roles_key 的 Index Scan 更直白；
//   - activated / email_verified 的布尔是**两根独立的轴**（拍板 §9.12），
//     所以是两个参数而不是一个三态；
//   - 排序键与游标逐字对齐：(u.id < $6)，第一页由 service 传 MaxInt64 的哨兵。
//
// adminUsersFilterSQL 是筛选条件本身（$1..$5），**列表与计数共用这一份**。
// 复制一份给 count 就会漂移：改了列表的筛选而忘了改计数，屏上出现
// 「筛出来 3 条、标题写着共 137 人」——两边各自看着都正常。
const adminUsersFilterSQL = `($1::text IS NULL OR (u.username ILIKE $1 OR u.nickname ILIKE $1 OR u.email ILIKE $1))
   AND ($2::text IS NULL OR u.status = $2)
   AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM roles rr WHERE rr.id = u.role_id AND rr.key = $3))
   AND ($4::bool IS NULL OR (u.activated_at IS NOT NULL) = $4)
   AND ($5::bool IS NULL OR (u.email_verified_at IS NOT NULL) = $5)`

// adminUsersArgs 把筛选摊成上面那 5 个参数（列表与计数各用一次，顺序必须一致）。
func adminUsersArgs(f AdminUsersFilter) []any {
	return []any{
		likePattern(f.Q), nullText(f.Status), nullText(f.RoleKey),
		f.Activated, f.EmailVerified,
	}
}

const adminUsersSQL = `
SELECT u.id, u.public_id, u.username, u.nickname, u.email,
       u.status, u.email_verified_at, u.activated_at, u.trusted, u.level,
       u.created_at, u.last_login_at,
       r.key, r.name, COALESCE(r.badge_color, '')
  FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE ` + adminUsersFilterSQL + `
   AND u.id < $6
 ORDER BY u.id DESC
 LIMIT $7`

// AdminUserRow 是用户列表与详情共用的一行。
type AdminUserRow struct {
	ID              int64
	PublicID        string
	Username        string
	Nickname        string
	Email           string
	Status          string
	EmailVerifiedAt *time.Time
	ActivatedAt     *time.Time
	Trusted         bool
	Level           int
	CreatedAt       time.Time
	LastLoginAt     *time.Time
	RoleKey         string
	RoleName        string
	RoleBadge       string
}

func scanAdminUserRow(rows *sql.Rows) (AdminUserRow, error) {
	var r AdminUserRow
	var emailVerified, activated, lastLogin sql.NullTime
	if err := rows.Scan(&r.ID, scanUUID(&r.PublicID), &r.Username, &r.Nickname, &r.Email,
		&r.Status, &emailVerified, &activated, &r.Trusted, &r.Level,
		&r.CreatedAt, &lastLogin, &r.RoleKey, &r.RoleName, &r.RoleBadge); err != nil {
		return r, err
	}
	r.EmailVerifiedAt = nullTimePtr(emailVerified)
	r.ActivatedAt = nullTimePtr(activated)
	r.LastLoginAt = nullTimePtr(lastLogin)
	return r, nil
}

// ListAdminUsers 按筛选取一页（id DESC）。
func ListAdminUsers(ctx context.Context, q Querier, f AdminUsersFilter) ([]AdminUserRow, error) {
	after := f.AfterID
	if after == 0 {
		after = math.MaxInt64
	}
	rows, err := q.QueryContext(ctx, adminUsersSQL,
		append(adminUsersArgs(f), after, f.Limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminUserRow
	for rows.Next() {
		r, err := scanAdminUserRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminUsersCounts 是「整个筛选结果集」的四个数：总数 + 三根状态轴的计数。
//
// 为什么要一次算四个数：用户报的缺陷就是「只显示 20 人、看不到总人数」，
// 而上面那三格（已封禁/待激活/未验证）如果只数本页，屏上会同时出现
// 「共 137 人」和「本页已封禁 0」——两个数都真，读起来却自相矛盾。
// 一条 SQL + GROUP BY 三根轴的布尔表达式即可（三根轴都是 NULL 判定，不用三次 count）。
func AdminUsersCounts(ctx context.Context, q Querier, f AdminUsersFilter) (AdminUsersCount, error) {
	var c AdminUsersCount
	rows, err := q.QueryContext(ctx, adminUsersCountSQL, adminUsersArgs(f)...)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	// 分组可能有 0～8 行（三根布尔轴的组合），全不存在时**一行都没有**。
	for rows.Next() {
		var n, banned, pending, unverified int
		if err := rows.Scan(&n, &banned, &pending, &unverified); err != nil {
			return c, err
		}
		c.Total += n
		c.Banned += banned
		c.Pending += pending
		c.Unverified += unverified
	}
	return c, rows.Err()
}

// AdminUsersCount 是上面那条查询的结果。
type AdminUsersCount struct {
	Total      int
	Banned     int
	Pending    int
	Unverified int
}

// adminUsersCountSQL 给整个筛选结果集的四个数：总数 + 三根状态轴的计数。
//
// 三根轴在原列上都是 NULL 判定，所以 GROUP BY 三个布尔表达式一次扫完（不用三次 count）。
// 它按**同一份** adminUsersFilterSQL 过滤：筛了「只看未激活」时，总数就是未激活的人数。
const adminUsersCountSQL = `
SELECT count(*),
       count(*) FILTER (WHERE u.status = 'banned'),
       count(*) FILTER (WHERE u.activated_at IS NULL),
       count(*) FILTER (WHERE u.email_verified_at IS NULL)
  FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE ` + adminUsersFilterSQL + `
 GROUP BY (u.status = 'banned'), (u.activated_at IS NULL), (u.email_verified_at IS NULL)`

// AdminUserByPublicID 是详情那一行。id 是 public_id 的**文本形式**
// （pgx 按参数的静态类型 uuid 编码；转成 pgtype.UUID 反而要多一次转换，见 scanUUID 的注释）。
// 查不到返回 sql.ErrNoRows（service 翻成 404）。
func AdminUserByPublicID(ctx context.Context, q Querier, id string) (AdminUserRow, error) {
	var r AdminUserRow
	rows, err := q.QueryContext(ctx, adminUserByIDSQL, id)
	if err != nil {
		return r, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return r, err
		}
		return r, sql.ErrNoRows
	}
	r, err = scanAdminUserRow(rows)
	return r, err
}

const adminUserByIDSQL = `
SELECT u.id, u.public_id, u.username, u.nickname, u.email,
       u.status, u.email_verified_at, u.activated_at, u.trusted, u.level,
       u.created_at, u.last_login_at,
       r.key, r.name, COALESCE(r.badge_color, '')
  FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE u.public_id = $1`

// ContentCount 是一个用户的内容数。
type ContentCount struct {
	Topics  int
	Replies int
}

// AdminUserContentCounts 一次取回一页用户的内容数（发主题数 / 回帖数）。
//
// 为什么用 GROUP BY + JOIN 而不是每个用户两条 count()：列表一页 20 行就是 40 次往返。
// 两个 JOIN 都在 (author_id) 上有索引（idx_topics_author / idx_posts_author）。
func AdminUserContentCounts(ctx context.Context, q Querier, ids []int64) (map[int64]ContentCount, error) {
	out := make(map[int64]ContentCount, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, adminUserCountsSQL, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var c ContentCount
		if err := rows.Scan(&id, &c.Topics, &c.Replies); err != nil {
			return nil, err
		}
		out[id] = c
	}
	return out, rows.Err()
}

const adminUserCountsSQL = `
SELECT u.id,
       (SELECT count(*) FROM topics t WHERE t.author_id = u.id),
       (SELECT count(*) FROM posts p WHERE p.author_id = u.id)
  FROM users u
 WHERE u.id = ANY($1::bigint[])`

// ── 详情的三张关联表 ──────────────────────────────────────────────

// AdminSanctionRow 是一条处罚（带分区 slug/name；全站处罚的两列为 NULL）。
type AdminSanctionRow struct {
	ID        int64
	Action    string
	BoardSlug *string
	BoardName *string
	Reason    string
	Until     *time.Time
	CreatedAt time.Time
}

// AdminUserSanctions 按「未过期优先、再按开单时间倒序」给出处罚历史。
// **不隐藏过期行**：后台要能回答「这个人被处理过几次」，删掉历史就答不了。
func AdminUserSanctions(ctx context.Context, q Querier, userID int64) ([]AdminSanctionRow, error) {
	rows, err := q.QueryContext(ctx, `
SELECT sa.id, sa.action, b.slug, b.name, sa.reason, sa.until, sa.created_at
  FROM sanctions sa
  LEFT JOIN boards b ON b.id = sa.board_id
 WHERE sa.user_id = $1
 ORDER BY (sa.until IS NULL OR sa.until > now()) DESC, sa.created_at DESC, sa.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminSanctionRow
	for rows.Next() {
		var r AdminSanctionRow
		var until sql.NullTime
		if err := rows.Scan(&r.ID, &r.Action, &r.BoardSlug, &r.BoardName, &r.Reason, &until, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Until = nullTimePtr(until)
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminGrantRow 是一条点对点追加的权限（连权限点的中文名一起取回）。
type AdminGrantRow struct {
	Key       string
	Name      string
	Reason    string
	ExpiresAt *time.Time
	GrantedAt time.Time
}

// AdminUserGrants 返回该用户的全部追加权限，**含已过期的**（后台要看到「给过什么」）。
func AdminUserGrants(ctx context.Context, q Querier, userID int64) ([]AdminGrantRow, error) {
	rows, err := q.QueryContext(ctx, `
SELECT p.key, p.name, up.reason, up.expires_at, up.granted_at
  FROM user_permissions up
  JOIN permissions p ON p.id = up.permission_id
 WHERE up.user_id = $1
 ORDER BY (up.expires_at IS NULL OR up.expires_at > now()) DESC, p.key`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminGrantRow
	for rows.Next() {
		var r AdminGrantRow
		var expires sql.NullTime
		if err := rows.Scan(&r.Key, &r.Name, &r.Reason, &expires, &r.GrantedAt); err != nil {
			return nil, err
		}
		r.ExpiresAt = nullTimePtr(expires)
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminTitleRow 是用户持有的一个头衔。
type AdminTitleRow struct {
	PublicID    string
	Key         string
	Name        string
	Color       string
	Description string
	GrantedAt   time.Time
	ArchivedAt  *time.Time
}

// AdminUserTitles 返回该用户的头衔（含已归档的：归档不删，持有者仍要看得见）。
func AdminUserTitles(ctx context.Context, q Querier, userID int64) ([]AdminTitleRow, error) {
	rows, err := q.QueryContext(ctx, `
SELECT t.public_id, t.key, t.name, t.color, t.description, ut.granted_at, t.archived_at
  FROM user_titles ut
  JOIN titles t ON t.id = ut.title_id
 WHERE ut.user_id = $1
 ORDER BY (t.archived_at IS NULL) DESC, t.key`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminTitleRow
	for rows.Next() {
		var r AdminTitleRow
		var archived sql.NullTime
		if err := rows.Scan(scanUUID(&r.PublicID), &r.Key, &r.Name, &r.Color, &r.Description,
			&r.GrantedAt, &archived); err != nil {
			return nil, err
		}
		r.ArchivedAt = nullTimePtr(archived)
		out = append(out, r)
	}
	return out, rows.Err()
}

// likePattern 把用户输入包成 ILIKE 的 %…%（只用参数，不拼 SQL；用户在 term 里写 % 只是匹配更多）。
func likePattern(q string) *string {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil
	}
	p := "%" + q + "%"
	return &p
}

func nullTimePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}
