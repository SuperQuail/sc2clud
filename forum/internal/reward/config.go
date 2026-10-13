package reward

import (
	"context"
	"fmt"

	ent "forum/internal/ent"
	"forum/internal/ent/donationnoticedefault"
	"forum/internal/ent/userdonationsetting"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"

	"forum/internal/authz"
)

// GetMySettings 读本人的三个开关 + 文案。没有行就是默认值（旧站默认全关、提示开）。
func (s *Service) GetMySettings(ctx context.Context, actor *authz.Actor) (*DonationSettings, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	row, err := s.db.UserDonationSetting.Query().
		Where(userdonationsetting.UserIDEQ(actor.UserID)).
		Only(ctx)
	if err != nil {
		if isNotFound(err) {
			return &DonationSettings{NoticeVisible: true}, nil
		}
		return nil, fmt.Errorf("读赞赏设置: %w", err)
	}
	return settingsView(row), nil
}

// UpdateMySettings 是部分字段更新：没传的字段保持原值（没有行时用默认值建行）。
func (s *Service) UpdateMySettings(ctx context.Context, actor *authz.Actor, in UpdateDonationSettingsInput) (*DonationSettings, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	now := s.clk.Now()
	var out *DonationSettings
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.UserDonationSetting.Query().
			Where(userdonationsetting.UserIDEQ(actor.UserID)).
			Only(ctx)
		switch {
		case err == nil:
			up := row.Update().SetUpdatedAt(now)
			if in.ShowChannels != nil {
				up = up.SetShowChannels(*in.ShowChannels)
			}
			if in.RecordsPublic != nil {
				up = up.SetRecordsPublic(*in.RecordsPublic)
			}
			if in.NoticeVisible != nil {
				up = up.SetNoticeVisible(*in.NoticeVisible)
			}
			if in.NoticeText != nil {
				up = up.SetNoticeText(*in.NoticeText)
			}
			row, err = up.Save(ctx)
			if err != nil {
				return fmt.Errorf("更新赞赏设置: %w", err)
			}
		case isNotFound(err):
			// 建行时先落默认值（旧站默认全关、提示开），再套用传进来的字段
			cr := tx.UserDonationSetting.Create().
				SetUserID(actor.UserID).
				SetShowChannels(false).
				SetRecordsPublic(false).
				SetNoticeVisible(true)
			if in.ShowChannels != nil {
				cr = cr.SetShowChannels(*in.ShowChannels)
			}
			if in.RecordsPublic != nil {
				cr = cr.SetRecordsPublic(*in.RecordsPublic)
			}
			if in.NoticeVisible != nil {
				cr = cr.SetNoticeVisible(*in.NoticeVisible)
			}
			if in.NoticeText != nil {
				cr = cr.SetNoticeText(*in.NoticeText)
			}
			row, err = cr.Save(ctx)
			if err != nil {
				return fmt.Errorf("建赞赏设置: %w", err)
			}
		default:
			return fmt.Errorf("读赞赏设置: %w", err)
		}
		out = settingsView(row)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func settingsView(r *ent.UserDonationSetting) *DonationSettings {
	return &DonationSettings{
		ShowChannels:  r.ShowChannels,
		RecordsPublic: r.RecordsPublic,
		NoticeVisible: r.NoticeVisible,
		NoticeText:    r.NoticeText,
	}
}

// GetNoticeDefaults 读按渠道的默认提示文案（最多四行）。
func (s *Service) GetNoticeDefaults(ctx context.Context, actor *authz.Actor) ([]NoticeDefault, error) {
	rows, err := s.db.DonationNoticeDefault.Query().
		Order(donationnoticedefault.ByChannel()).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读默认提示文案: %w", err)
	}
	out := make([]NoticeDefault, 0, len(rows))
	for _, r := range rows {
		out = append(out, NoticeDefault{Channel: r.Channel, Text: r.Text})
	}
	return out, nil
}

// UpdateNoticeDefaults 是整表替换（不是 upsert）：传进来的就是替换后的全集。
func (s *Service) UpdateNoticeDefaults(ctx context.Context, actor *authz.Actor, in NoticeDefaultsInput) ([]NoticeDefault, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(in.Items))
	for _, it := range in.Items {
		if seen[it.Channel] {
			return nil, apperr.Invalid(map[string]string{"items": "同一个渠道只能有一条"})
		}
		seen[it.Channel] = true
	}
	now := s.clk.Now()
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		if _, err := tx.DonationNoticeDefault.Delete().Exec(ctx); err != nil {
			return fmt.Errorf("清空默认提示文案: %w", err)
		}
		for _, it := range in.Items {
			if err := tx.DonationNoticeDefault.Create().
				SetChannel(it.Channel).
				SetText(it.Text).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Exec(ctx); err != nil {
				return fmt.Errorf("写默认提示文案 %s: %w", it.Channel, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetNoticeDefaults(ctx, actor)
}
