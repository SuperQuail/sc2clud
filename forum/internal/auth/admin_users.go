package auth

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	"forum/internal/platform/idgen"
)

// 管理端的用户读路径（交接单 C1：后台用户屏此前只能是一张假表）。
//
// 与「公开资料」的分界：这里返回**邮箱、三根状态轴、处罚、追加权限**，
// 所以两条路由都挂 user.ban（§5.8 把用户管理归在「用户与权限」那一组，
// 而现有 admin 段里一个管用户的读接口都没有 —— 沿用同组权限点，不新造）。
//
// SQL 走本域的 pgsql 包（开发必读 §1 第 8 条：原生 SQL 只在各域 pgsql 与手写迁移里）。

// AdminUsersQuery 是 GET /admin/users 的筛选（参数名照 §5.8 / §21.1）。
type AdminUsersQuery struct {
	Q             string // 登录名 / 昵称 / 邮箱，三列 ILIKE
	Status        string // active | banned | deleted
	Role          string // roles.key
	Activated     *bool
	EmailVerified *bool
	Limit         int
	Cursor        string
}

// ── 对外形状（JSON 字段名即契约） ──────────────────────────────────

// AdminUserRoleRef 是用户行上的基线角色。key 是 **roles.key**（对外用 key 指代角色；
// /admin/roles 的 RoleItem.id 才是自增 id）。
type AdminUserRoleRef struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	BadgeColor string `json:"badge_color"`
}

// AdminUserDTO 是用户列表项。**不返回 password_hash / 会话 / IP**：
// 后台要能管账号，不需要能冒充账号。
type AdminUserDTO struct {
	ID              string           `json:"id"`
	Username        string           `json:"username"`
	Nickname        string           `json:"nickname"`
	Email           string           `json:"email"`
	Role            AdminUserRoleRef `json:"role"`
	Status          string           `json:"status"`
	EmailVerifiedAt *time.Time       `json:"email_verified_at"`
	ActivatedAt     *time.Time       `json:"activated_at"`
	Trusted         bool             `json:"trusted"`
	Level           int              `json:"level"`
	CreatedAt       time.Time        `json:"created_at"`
	LastLoginAt     *time.Time       `json:"last_login_at"`
	TopicCount      int              `json:"topic_count"`
	ReplyCount      int              `json:"reply_count"`
}

// AdminSanctionDTO 是一条处罚。board 为 null = 全站；until 为 null = 永久。
type AdminSanctionDTO struct {
	ID        int64         `json:"id"`
	Action    string        `json:"action"` // post | reply | all
	Board     *BoardRefLite `json:"board"`
	Reason    string        `json:"reason"`
	Until     *time.Time    `json:"until"`
	CreatedAt time.Time     `json:"created_at"`
}

// BoardRefLite 是处罚上的分区指代（同 BoardRefDTO 的两列，但本包不 import forum 域）。
type BoardRefLite struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// AdminGrantDTO 是一条点对点追加的权限（§5.8 要求带 reason / expires_at）。
type AdminGrantDTO struct {
	Key       string     `json:"key"`
	Name      string     `json:"name"`
	Reason    string     `json:"reason"`
	ExpiresAt *time.Time `json:"expires_at"`
	GrantedAt time.Time  `json:"granted_at"`
}

// AdminTitleDTO 是用户持有的头衔。
type AdminTitleDTO struct {
	ID          string     `json:"id"`
	Key         string     `json:"key"`
	Name        string     `json:"name"`
	Color       string     `json:"color"`
	Description string     `json:"description"`
	GrantedAt   time.Time  `json:"granted_at"`
	ArchivedAt  *time.Time `json:"archived_at"`
}

// AdminUserDetailDTO 是 GET /admin/users/{id}：列表项 + 三张关联表（§5.8）。
type AdminUserDetailDTO struct {
	AdminUserDTO
	Sanctions       []AdminSanctionDTO `json:"sanctions"`
	UserPermissions []AdminGrantDTO    `json:"user_permissions"`
	UserTitles      []AdminTitleDTO    `json:"user_titles"`
}

// ── 读 ────────────────────────────────────────────────────────────

// ListAdminUsers 返回一页用户与下一页游标（按 id DESC：uuid v7 时间有序，新注册的在最前）。
func (s *Service) ListAdminUsers(ctx context.Context, actor *authz.Actor, in AdminUsersQuery) ([]AdminUserDTO, string, error) {
	p, err := s.ListAdminUsersPage(ctx, actor, in)
	if err != nil {
		return nil, "", err
	}
	return p.Items, p.Next, nil
}

// AdminUsersCountsDTO 是整个筛选结果集的四个数（不是本页条数）。
type AdminUsersCountsDTO struct {
	Total      int `json:"total"`
	Banned     int `json:"banned"`
	Pending    int `json:"pending_activation"`
	Unverified int `json:"email_unverified"`
}

// AdminUsersPageDTO 是 v2 的用户列表包络（data + next_cursor + counts）。
//
// 为什么不新开一条 GET /admin/users/count：两次往返之间有人注册，屏上就会出现
// 「列表 21 条、总数 20」这种自相矛盾的数；而两个数的 WHERE 还得各写一份、各自漂移。
type AdminUsersPageDTO struct {
	Items  []AdminUserDTO      `json:"items"`
	Next   string              `json:"next_cursor"`
	Counts AdminUsersCountsDTO `json:"counts"`
}

// ListAdminUsersPage 是 v2：一页用户 + 下一页游标 + 整个筛选结果集的计数。
func (s *Service) ListAdminUsersPage(ctx context.Context, actor *authz.Actor, in AdminUsersQuery) (*AdminUsersPageDTO, error) {
	if err := requirePerm(actor, authz.PermUserBan); err != nil {
		return nil, err
	}
	f, limit, err := s.adminUsersFilter(in)
	if err != nil {
		return nil, err
	}
	f.Limit = limit + 1 // 多取一行判有没有下一页
	rows, err := pgsql.ListAdminUsers(ctx, s.db, f)
	if err != nil {
		return nil, err
	}
	out := make([]AdminUserDTO, 0, min(len(rows), limit))
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = encodeUserCursor(rows[len(rows)-1].ID)
	}
	// 计数与列表用**同一份筛选**（pgsql 里就是一个常量）：筛出来的条数与总数必须对得上。
	c, err := pgsql.AdminUsersCounts(ctx, s.db, f)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		ids := make([]int64, 0, len(rows))
		for _, r := range rows {
			ids = append(ids, r.ID)
		}
		content, err := pgsql.AdminUserContentCounts(ctx, s.db, ids)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			out = append(out, adminUserDTO(r, content[r.ID]))
		}
	}
	return &AdminUsersPageDTO{
		Items: out, Next: next,
		Counts: AdminUsersCountsDTO{Total: c.Total, Banned: c.Banned, Pending: c.Pending, Unverified: c.Unverified},
	}, nil
}

// adminUsersFilter 校验查询并摊成 SQL 的筛选（v1 与 v2 共用一份校验，不各写一套）。
func (s *Service) adminUsersFilter(in AdminUsersQuery) (pgsql.AdminUsersFilter, int, error) {
	q := strings.TrimSpace(in.Q)
	if len([]rune(q)) > 100 {
		return pgsql.AdminUsersFilter{}, 0, invalid("q", "最多 100 字")
	}
	status := strings.TrimSpace(in.Status)
	if status != "" && status != StatusActive && status != StatusBanned && status != StatusDeleted {
		return pgsql.AdminUsersFilter{}, 0, invalid("status", "只能是 active / banned / deleted")
	}
	var after int64
	if in.Cursor != "" {
		v, err := decodeUserCursor(in.Cursor)
		if err != nil {
			return pgsql.AdminUsersFilter{}, 0, err
		}
		after = v
	}
	return pgsql.AdminUsersFilter{
		Q: q, Status: status, RoleKey: strings.TrimSpace(in.Role),
		Activated: in.Activated, EmailVerified: in.EmailVerified, AfterID: after,
	}, normalizeLimit(in.Limit), nil
}

// AdminUserDetail 是详情：用户行 + sanctions / user_permissions / user_titles。
func (s *Service) AdminUserDetail(ctx context.Context, actor *authz.Actor, publicID string) (*AdminUserDetailDTO, error) {
	if err := requirePerm(actor, authz.PermUserBan); err != nil {
		return nil, err
	}
	// 先过 idgen.ParsePublicID 把「不是 uuid」与「不存在」归成同一个 404：
	// 对外 ID 一律 uuid，非 uuid 连查都不该查（与 ValidPathIDs 的语义一致）。
	if _, err := idgen.ParsePublicID(publicID); err != nil {
		return nil, ErrAdminUserNotFound
	}
	row, err := pgsql.AdminUserByPublicID(ctx, s.db, publicID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrAdminUserNotFound
		}
		return nil, err
	}
	sanctions, err := pgsql.AdminUserSanctions(ctx, s.db, row.ID)
	if err != nil {
		return nil, err
	}
	grants, err := pgsql.AdminUserGrants(ctx, s.db, row.ID)
	if err != nil {
		return nil, err
	}
	titles, err := pgsql.AdminUserTitles(ctx, s.db, row.ID)
	if err != nil {
		return nil, err
	}
	d := &AdminUserDetailDTO{
		AdminUserDTO:    adminUserDTO(row, pgsql.ContentCount{}),
		Sanctions:       make([]AdminSanctionDTO, 0, len(sanctions)),
		UserPermissions: make([]AdminGrantDTO, 0, len(grants)),
		UserTitles:      make([]AdminTitleDTO, 0, len(titles)),
	}
	for _, x := range sanctions {
		item := AdminSanctionDTO{
			ID: x.ID, Action: x.Action, Reason: x.Reason,
			Until: utcPtr(x.Until), CreatedAt: x.CreatedAt.UTC(),
		}
		if x.BoardSlug != nil {
			item.Board = &BoardRefLite{Slug: *x.BoardSlug, Name: deref(x.BoardName)}
		}
		d.Sanctions = append(d.Sanctions, item)
	}
	for _, x := range grants {
		d.UserPermissions = append(d.UserPermissions, AdminGrantDTO{
			Key: x.Key, Name: x.Name, Reason: x.Reason,
			ExpiresAt: utcPtr(x.ExpiresAt), GrantedAt: x.GrantedAt.UTC(),
		})
	}
	for _, x := range titles {
		d.UserTitles = append(d.UserTitles, AdminTitleDTO{
			ID: x.PublicID, Key: x.Key, Name: x.Name, Color: x.Color, Description: x.Description,
			GrantedAt: x.GrantedAt.UTC(), ArchivedAt: utcPtr(x.ArchivedAt),
		})
	}
	return d, nil
}

func adminUserDTO(r pgsql.AdminUserRow, c pgsql.ContentCount) AdminUserDTO {
	return AdminUserDTO{
		ID: r.PublicID, Username: r.Username, Nickname: displayName(r.Nickname, r.Username),
		Email:  r.Email,
		Role:   AdminUserRoleRef{Key: r.RoleKey, Name: r.RoleName, BadgeColor: r.RoleBadge},
		Status: r.Status, EmailVerifiedAt: utcPtr(r.EmailVerifiedAt), ActivatedAt: utcPtr(r.ActivatedAt),
		Trusted: r.Trusted, Level: r.Level,
		CreatedAt: r.CreatedAt.UTC(), LastLoginAt: utcPtr(r.LastLoginAt),
		TopicCount: c.Topics, ReplyCount: c.Replies,
	}
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// ── 游标 ──────────────────────────────────────────────────────────
//
// 用户列表按 id DESC 翻页。游标里放自增 id：它是不透明串，前端只回传不解释
// （与 auditCursor 同一个取舍，见 audit.go）。

type userCursor struct {
	ID int64 `json:"id"`
}

func encodeUserCursor(id int64) string {
	b, _ := json.Marshal(userCursor{ID: id})
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeUserCursor(s string) (int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, invalid("cursor", "游标格式不正确")
	}
	var c userCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return 0, invalid("cursor", "游标格式不正确")
	}
	return c.ID, nil
}
