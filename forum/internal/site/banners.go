package site

import (
	"context"
	"fmt"
	"slices"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/banner"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	platformdb "forum/internal/platform/db"
	"forum/internal/platform/idgen"
	"forum/internal/site/pgsql"
)

// ListBanners 是后台列表（含停用的与未到生效时间的）。
func (s *Service) ListBanners(ctx context.Context, actor *authz.Actor, in CursorInput) (*BannerPage, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	cur, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	q := s.db.Banner.Query()
	if cur != nil {
		q = q.Where(banner.Or(
			banner.CreatedAtLT(cur.T),
			banner.And(banner.CreatedAtEQ(cur.T), banner.IDLT(cur.ID)),
		))
	}
	rows, err := q.Order(ent.Desc(banner.FieldCreatedAt), ent.Desc(banner.FieldID)).
		Limit(limit + 1).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读横幅: %w", err)
	}
	out := &BannerPage{Items: make([]Banner, 0, len(rows))}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		out.NextCursor = encodeCursor(last.CreatedAt, last.ID)
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	roles, err := s.pg.RolesByBanners(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out.Items = append(out.Items, bannerView(r, roles[r.ID]))
	}
	return out, nil
}

// CreateBanner 建一条横幅（含定向角色，同一事务）。
func (s *Service) CreateBanner(ctx context.Context, actor *authz.Actor, in BannerInput) (*Banner, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	if !validBannerURL(in.URL) {
		return nil, ErrBadURL
	}
	now := s.clk.Now()
	startsAt := now
	if in.StartsAt != nil {
		startsAt = in.StartsAt.UTC()
	}
	if in.EndsAt != nil && !in.EndsAt.After(startsAt) {
		return nil, apperr.Invalid(map[string]string{"ends_at": "结束时间必须晚于开始时间"})
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	pid, err := idgen.NewPublicID()
	if err != nil {
		return nil, fmt.Errorf("生成横幅 id: %w", err)
	}
	roles := normalizeRoles(in.Roles)

	var out Banner
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.Banner.Create().
			SetPublicID(pid).
			SetKind(in.Kind).
			SetText(in.Text).
			SetNillableURL(urlOrNil(in.URL)).
			SetStartsAt(startsAt).
			SetNillableEndsAt(in.EndsAt).
			SetEnabled(enabled).
			SetCreatedBy(actor.UserID).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			return fmt.Errorf("建横幅: %w", err)
		}
		if err := replaceRoles(ctx, tx, row.ID, roles); err != nil {
			return err
		}
		out = bannerView(row, roles)
		return s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionBannerCreate,
			TargetType: "banner", TargetID: pid.String(),
			Detail: map[string]any{"after": map[string]any{
				"kind": in.Kind, "enabled": enabled, "starts_at": startsAt, "ends_at": in.EndsAt, "roles": roles,
			}},
			IP: in.IP,
		})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateBanner 改内容 / 启停 / 改窗口 / 改定向。nil = 不改。
func (s *Service) UpdateBanner(ctx context.Context, actor *authz.Actor, publicID string, in BannerPatch) (*Banner, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	if in.URL != nil && !validBannerURL(*in.URL) {
		return nil, ErrBadURL
	}
	pid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	if in.ClearEndsAt && in.EndsAt != nil {
		return nil, apperr.Invalid(map[string]string{"ends_at": "ends_at 与 clear_ends_at 只能给一个"})
	}
	now := s.clk.Now()

	var out Banner
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		txq := pgsql.NewTx(tx)
		row, err := tx.Banner.Query().Where(banner.PublicIDEQ(pid)).Only(ctx)
		if ent.IsNotFound(err) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("读横幅: %w", err)
		}
		before := map[string]any{
			"kind": row.Kind, "enabled": row.Enabled,
			"starts_at": row.StartsAt, "ends_at": row.EndsAt,
		}
		up := tx.Banner.UpdateOneID(row.ID).SetUpdatedAt(now)
		if in.Kind != nil {
			up = up.SetKind(*in.Kind)
		}
		if in.Text != nil {
			up = up.SetText(*in.Text)
		}
		if in.URL != nil {
			up = up.SetNillableURL(urlOrNil(*in.URL))
		}
		if in.StartsAt != nil {
			up = up.SetStartsAt(in.StartsAt.UTC())
		}
		if in.EndsAt != nil {
			up = up.SetEndsAt(in.EndsAt.UTC())
		}
		if in.ClearEndsAt {
			up = up.ClearEndsAt()
		}
		if in.Enabled != nil {
			up = up.SetEnabled(*in.Enabled)
		}
		updated, err := up.Save(ctx)
		if err != nil {
			return fmt.Errorf("改横幅: %w", err)
		}
		if updated.EndsAt != nil && !updated.EndsAt.After(updated.StartsAt) {
			return apperr.Invalid(map[string]string{"ends_at": "结束时间必须晚于开始时间"})
		}

		roles := normalizeRoles(derefRoles(in.Roles))
		if in.Roles != nil {
			if err := replaceRoles(ctx, tx, row.ID, roles); err != nil {
				return err
			}
		} else {
			m, err := txq.RolesByBanners(ctx, []int64{row.ID})
			if err != nil {
				return err
			}
			roles = m[row.ID]
		}
		out = bannerView(updated, roles)
		return s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionBannerUpdate,
			TargetType: "banner", TargetID: pid.String(),
			Detail: map[string]any{"before": before, "after": map[string]any{
				"kind": updated.Kind, "enabled": updated.Enabled,
				"starts_at": updated.StartsAt, "ends_at": updated.EndsAt, "roles": roles,
			}},
			IP: in.IP,
		})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// replaceRoles 整表替换定向：删了再插。
// 「无行 = 所有人」是这张表的语义（拍板 §8.11 U10），所以「清空定向」就是删掉全部行。
func replaceRoles(ctx context.Context, tx *ent.Tx, bannerID int64, keys []string) error {
	txq := pgsql.NewTx(tx)
	byKey, err := txq.RoleIDsByKeys(ctx, keys)
	if err != nil {
		return err
	}
	for _, k := range keys {
		if _, ok := byKey[k]; !ok {
			return apperr.Invalid(map[string]string{"roles": "角色不存在: " + k})
		}
	}
	return txq.ReplaceBannerRoles(ctx, bannerID, byKey, keys)
}

func bannerView(r *ent.Banner, roles []string) Banner {
	v := Banner{
		ID: r.PublicID.String(), Kind: r.Kind, Text: r.Text,
		StartsAt: r.StartsAt, EndsAt: r.EndsAt, Enabled: r.Enabled,
		Roles: roles, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
	if v.Roles == nil {
		v.Roles = []string{}
	}
	if r.URL != nil {
		v.URL = *r.URL
	}
	return v
}

// normalizeRoles 去重并排序：定向是一组角色，顺序没有意义（排序让审计与响应稳定）。
func normalizeRoles(keys []string) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		if k == "" || slices.Contains(out, k) {
			continue
		}
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func derefRoles(p *[]string) []string {
	if p == nil {
		return nil
	}
	return *p
}

// urlOrNil：横幅的 url 列可空，空串按「没有链接」存（读回来是 NULL，不是空串）。
func urlOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
