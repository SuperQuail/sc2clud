package reward

import (
	"context"
	"fmt"

	"forum/internal/ent/paymentchannel"
	"forum/internal/ent/userdonationsetting"
	"forum/internal/platform/apperr"

	"forum/internal/authz"
)

// Channels 是某个用户的收款码。show_channels=false 或站点关了赞赏 → 空数组（不是 null）。
func (s *Service) Channels(ctx context.Context, actor *authz.Actor, handle string) ([]Channel, error) {
	pol, err := s.channelsPolicy(ctx, handle)
	if err != nil {
		return nil, err
	}
	if !pol.show {
		return []Channel{}, nil
	}
	rows, err := s.db.PaymentChannel.Query().
		Where(paymentchannel.UserIDEQ(pol.userID)).
		Order(paymentchannel.BySort(), paymentchannel.ByID()).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读收款码: %w", err)
	}
	out := make([]Channel, 0, len(rows))
	for _, r := range rows {
		out = append(out, Channel{
			ID:    r.PublicID.String(),
			Label: r.Label,
			Image: "/img/" + r.ImageHash,
			Sort:  r.Sort,
		})
	}
	return out, nil
}

// noticePolicy 是「这个人能不能被展示赞赏相关内容」的判定结果。
type noticePolicy struct {
	userID int64
	show   bool
}

// channelsPolicy：站点开关 → 用户存在且 active → 本人的 show_channels。
func (s *Service) channelsPolicy(ctx context.Context, handle string) (noticePolicy, error) {
	if !s.enabled(ctx) {
		return noticePolicy{}, nil
	}
	userID, err := s.users.IDByHandle(ctx, handle)
	if err != nil {
		return noticePolicy{}, apperr.ErrNotFound
	}
	b, err := s.users.Basic(ctx, userID)
	if err != nil {
		return noticePolicy{}, fmt.Errorf("读用户画像 %d: %w", userID, err)
	}
	if b.Status != "active" {
		// 封号/注销用户不收赞赏，也不泄露其状态
		return noticePolicy{}, apperr.ErrNotFound
	}
	row, err := s.db.UserDonationSetting.Query().
		Where(userdonationsetting.UserIDEQ(userID)).
		Only(ctx)
	if err != nil {
		if isNotFound(err) {
			return noticePolicy{userID: userID}, nil // 没设置过 = 默认全关
		}
		return noticePolicy{}, fmt.Errorf("读赞赏设置: %w", err)
	}
	return noticePolicy{userID: userID, show: row.ShowChannels}, nil
}
