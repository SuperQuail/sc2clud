package site

import (
	"context"
	"fmt"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/announcement"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	platformdb "forum/internal/platform/db"
	"forum/internal/platform/idgen"
)

// ListAnnouncements 是后台列表：含草稿与停用的（首页那条路只给已发布的）。
func (s *Service) ListAnnouncements(ctx context.Context, actor *authz.Actor, in CursorInput) (*AnnouncementPage, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	cur, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	q := s.db.Announcement.Query()
	if cur != nil {
		q = q.Where(announcement.Or(
			announcement.CreatedAtLT(cur.T),
			announcement.And(announcement.CreatedAtEQ(cur.T), announcement.IDLT(cur.ID)),
		))
	}
	rows, err := q.Order(ent.Desc(announcement.FieldCreatedAt), ent.Desc(announcement.FieldID)).
		Limit(limit + 1).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读公告: %w", err)
	}
	out := &AnnouncementPage{Items: make([]Announcement, 0, len(rows))}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		out.NextCursor = encodeCursor(last.CreatedAt, last.ID)
	}
	for _, r := range rows {
		out.Items = append(out.Items, announcementView(r))
	}
	return out, nil
}

// CreateAnnouncement 建一条公告：正文先渲染再入库（body_html 与 body_md 同事务写入，不会漂）。
func (s *Service) CreateAnnouncement(ctx context.Context, actor *authz.Actor, in AnnouncementInput) (*Announcement, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	html, err := renderMarkdown(in.BodyMD)
	if err != nil {
		return nil, fmt.Errorf("渲染公告正文: %w", err)
	}
	pid, err := idgen.NewPublicID()
	if err != nil {
		return nil, fmt.Errorf("生成公告 id: %w", err)
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	now := s.clk.Now()
	var publishedAt *time.Time
	if in.Publish != nil && *in.Publish {
		publishedAt = &now
	}

	var out Announcement
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.Announcement.Create().
			SetPublicID(pid).
			SetTitle(in.Title).
			SetBodyMd(in.BodyMD).
			SetBodyHTML(html).
			SetEnabled(enabled).
			SetNillablePublishedAt(publishedAt).
			SetCreatedBy(actor.UserID).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			return fmt.Errorf("建公告: %w", err)
		}
		out = announcementView(row)
		return s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionAnnouncementCreate,
			TargetType: "announcement", TargetID: pid.String(),
			Detail: map[string]any{"after": map[string]any{
				"title": in.Title, "enabled": enabled, "published_at": publishedAt,
			}},
			IP: in.IP,
		})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateAnnouncement 改 / 发布 / 下线。nil = 不改；Publish=false 表示下线（published_at 置 NULL）。
func (s *Service) UpdateAnnouncement(ctx context.Context, actor *authz.Actor, publicID string, in AnnouncementPatch) (*Announcement, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	pid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	// 正文只在真的改了才重渲染
	var html string
	if in.BodyMD != nil {
		html, err = renderMarkdown(*in.BodyMD)
		if err != nil {
			return nil, fmt.Errorf("渲染公告正文: %w", err)
		}
	}
	now := s.clk.Now()

	var out Announcement
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.Announcement.Query().Where(announcement.PublicIDEQ(pid)).Only(ctx)
		if ent.IsNotFound(err) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("读公告: %w", err)
		}
		before := map[string]any{
			"title": row.Title, "enabled": row.Enabled, "published_at": row.PublishedAt,
		}
		up := tx.Announcement.UpdateOneID(row.ID).SetUpdatedAt(now)
		if in.Title != nil {
			up = up.SetTitle(*in.Title)
		}
		if in.BodyMD != nil {
			up = up.SetBodyMd(*in.BodyMD).SetBodyHTML(html)
		}
		if in.Enabled != nil {
			up = up.SetEnabled(*in.Enabled)
		}
		if in.Publish != nil {
			if *in.Publish {
				// 已发布过就保留首次发布时间：改一次错别字不该把它顶到首页第一条
				if row.PublishedAt == nil {
					up = up.SetPublishedAt(now)
				}
			} else {
				up = up.ClearPublishedAt()
			}
		}
		updated, err := up.Save(ctx)
		if err != nil {
			return fmt.Errorf("改公告: %w", err)
		}
		out = announcementView(updated)
		return s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionAnnouncementUpdate,
			TargetType: "announcement", TargetID: pid.String(),
			Detail: map[string]any{"before": before, "after": map[string]any{
				"title": updated.Title, "enabled": updated.Enabled, "published_at": updated.PublishedAt,
			}},
			IP: in.IP,
		})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func announcementView(r *ent.Announcement) Announcement {
	return Announcement{
		ID: r.PublicID.String(), Title: r.Title,
		BodyMD: r.BodyMd, BodyHTML: r.BodyHTML,
		Enabled: r.Enabled, PublishedAt: r.PublishedAt,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}
