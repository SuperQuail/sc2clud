package forum

import (
	"context"
	"errors"
	"regexp"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/board"
	"forum/internal/forum/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/idgen"
)

// 管理端分区（交接单 C2 / 界面需求 §5.3 + §5.10）。权限点一律 board.manage。
//
// 两处刻意的取舍（写下来免得被当 bug）：
//  1. **列表不带 ACL**。分区屏做的是「角色 × 分区」矩阵，而每个分区有 4 个角色就是 4N 行；
//     列表只为每行显示「ACL 开/关」与「几个版主」。矩阵本身由 GET /admin/boards/{id}/acl 给，
//     打开某个分区的抽屉时才发那一次请求。
//  2. **slug 建了就不能改**。ent 的 board.go 原话：「不可改：改 slug 等于废掉所有外链」。
//     所以它只在 Create 的入参里出现，Update 连字段都不收。

// 值域与长度照 0004/0025 的 DDL：slug varchar(32) UNIQUE、name varchar(32)、description varchar(200)。
const (
	maxBoardSlugLen   = 32
	maxBoardNameLen   = 32
	maxBoardDescLen   = 200
	maxBoardModerator = 50
)

// slug 出现在 URL 里（/b/<slug>），所以限制成「小写字母数字与连字符」：
// 大写与空格会让同一本书出现两个看起来一样的链接。
var boardSlugRe = regexp.MustCompile("^[a-z0-9][a-z0-9-]{1,31}$")

const (
	boardStatusActive   = "active"
	boardStatusArchived = "archived"
)

var boardStatuses = map[string]bool{boardStatusActive: true, boardStatusArchived: true}

// ── DTO ──────────────────────────────────────────────────────────

// AdminBoardDTO 是后台分区列表项。
type AdminBoardDTO struct {
	ID           string           `json:"id"`
	Slug         string           `json:"slug"`
	Name         string           `json:"name"`
	Description  string           `json:"description"`
	CoverHash    string           `json:"cover_hash"`
	Status       string           `json:"status"`
	ACLEnabled   bool             `json:"acl_enabled"`
	MinPostLevel int              `json:"min_post_level"`
	Position     int              `json:"position"`
	TopicCount   int64            `json:"topic_count"`
	PostCount    int64            `json:"post_count"`
	TodayCount   int64            `json:"today_count"`
	Moderators   []AdminModerator `json:"moderators"`
}

// AdminModerator 是一行在任的版主任期。
type AdminModerator struct {
	UserID    string     `json:"user_id"`
	Handle    string     `json:"handle"`
	Nickname  string     `json:"nickname"`
	GrantedAt time.Time  `json:"granted_at"`
	ExpiresAt *time.Time `json:"expires_at"`
}

// AdminModeratorItem 是版主管理端点的回执（含历史行：grown_at 非空 = 已卸任）。
type AdminModeratorItem struct {
	AdminModerator
	GrownAt *time.Time `json:"grown_at"`
}

// AdminACLItem 是矩阵的一格。role_key 一起给：前端要显示的是「认证创作者」而不是一个数字。
type AdminACLItem struct {
	RoleID    int64  `json:"role_id"`
	RoleKey   string `json:"role_key"`
	CanPost   bool   `json:"can_post"`
	CanReply  bool   `json:"can_reply"`
	DenyPost  bool   `json:"deny_post"`
	DenyReply bool   `json:"deny_reply"`
}

// CreateBoardInput 是建分区。Status 空串按 active（新分区不该一上线就是归档）。
type CreateBoardInput struct {
	Slug         string
	Name         string
	Description  string
	Status       string
	ACLEnabled   bool
	MinPostLevel int
	CoverHash    *string
}

// UpdateBoardInput 是改分区：指针 = 没给。**没有 Slug**：改 slug 等于废掉所有外链。
type UpdateBoardInput struct {
	Name         *string
	Description  *string
	Status       *string
	ACLEnabled   *bool
	MinPostLevel *int
	CoverHash    *string
}

// ── 读 ────────────────────────────────────────────────────────────

// AdminListBoards 是后台的分区列表（含归档）。权限 board.manage。
func (s *Service) AdminListBoards(ctx context.Context, actor *authz.Actor) ([]AdminBoardDTO, error) {
	if err := requirePerm(actor, authz.PermBoardManage); err != nil {
		return nil, err
	}
	rows, err := s.repo.AdminBoards(ctx, s.todayStart())
	if err != nil {
		return nil, err
	}
	out := make([]AdminBoardDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, adminBoardDTO(r))
	}
	return out, nil
}

// AdminBoard 是单个分区的详情（与列表同一形状）。
func (s *Service) AdminBoard(ctx context.Context, actor *authz.Actor, publicID string) (*AdminBoardDTO, error) {
	if err := requirePerm(actor, authz.PermBoardManage); err != nil {
		return nil, err
	}
	id, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, ErrBoardNotFound
	}
	row, err := s.repo.AdminBoardByPublicID(ctx, id.String(), s.todayStart())
	if err != nil {
		if errors.Is(err, pgsql.ErrNoRows) {
			return nil, ErrBoardNotFound
		}
		return nil, err
	}
	d := adminBoardDTO(*row)
	return &d, nil
}

func adminBoardDTO(r pgsql.AdminBoardRow) AdminBoardDTO {
	d := AdminBoardDTO{
		ID: r.PublicID, Slug: r.Slug, Name: r.Name, Description: r.Description,
		Status: r.Status, ACLEnabled: r.ACLEnabled, MinPostLevel: r.MinPostLevel,
		Position: r.Position, TopicCount: r.TopicCount, PostCount: r.PostCount, TodayCount: r.TodayCount,
		Moderators: make([]AdminModerator, 0, len(r.Moderators)),
	}
	if r.CoverHash != nil {
		d.CoverHash = *r.CoverHash
	}
	for _, m := range r.Moderators {
		d.Moderators = append(d.Moderators, AdminModerator{
			UserID: m.UserID, Handle: m.Handle, Nickname: m.Nickname,
			GrantedAt: m.GrantedAt.UTC(), ExpiresAt: utcOrNil(m.ExpiresAt),
		})
	}
	return d
}

func utcOrNil(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

