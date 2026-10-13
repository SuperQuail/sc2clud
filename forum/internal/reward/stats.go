package reward

import (
	"context"
	"fmt"
	"sort"

	ent "forum/internal/ent"
	"forum/internal/ent/donationrecord"
	"forum/internal/ent/userdonationsetting"

	"forum/internal/authz"
)

// publicSets 返回两个授权集合：show_channels=true 的收款人、records_public=true 的打赏人。
//
// 口径要求两个开关都成立（d6-reward §6.4），所以取集合再 IN 过滤，而不是三层 EXISTS 子查询。
// 表里只有主动开过开关的人（旧站默认全关），这份扫描只在管理端统计跑。
func (s *Service) publicSets(ctx context.Context) (recipients, donors []int64, err error) {
	rows, err := s.db.UserDonationSetting.Query().
		Where(userdonationsetting.Or(
			userdonationsetting.ShowChannelsEQ(true),
			userdonationsetting.RecordsPublicEQ(true),
		)).
		All(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("读赞赏展示开关: %w", err)
	}
	for _, r := range rows {
		if r.ShowChannels {
			recipients = append(recipients, r.UserID)
		}
		if r.RecordsPublic {
			donors = append(donors, r.UserID)
		}
	}
	return recipients, donors, nil
}

// Stats 是管理侧统计：两个口径一起给，避免前后端各算一套。
func (s *Service) Stats(ctx context.Context, actor *authz.Actor, in StatsInput) (*DonationStats, error) {
	if err := requirePerm(actor, authz.PermRewardVerify); err != nil {
		return nil, err
	}
	approved := func() *ent.DonationRecordQuery {
		return s.db.DonationRecord.Query().Where(donationrecord.StateEQ(StateApproved))
	}
	out := &DonationStats{Leaderboard: []RecipientIncome{}}

	all, err := approved().
		Aggregate(ent.Sum(donationrecord.FieldAmountCents), ent.Count()).
		Ints(ctx)
	if err != nil {
		return nil, fmt.Errorf("统计全部收入: %w", err)
	}
	out.AllTotalCents, out.AllCount = pair(all)

	recipients, donors, err := s.publicSets(ctx)
	if err != nil {
		return nil, err
	}
	if out.AllCount == 0 || len(recipients) == 0 || len(donors) == 0 {
		return out, nil
	}
	public := func() *ent.DonationRecordQuery {
		return approved().Where(
			donationrecord.RecipientIDIn(recipients...),
			donationrecord.DonorIDIn(donors...),
		)
	}

	sum, err := public().
		Aggregate(ent.Sum(donationrecord.FieldAmountCents), ent.Count()).
		Ints(ctx)
	if err != nil {
		return nil, fmt.Errorf("统计公开收入: %w", err)
	}
	out.PublicTotalCents, out.PublicCount = pair(sum)

	// 排行榜在定义上就要看全体收款人，全表聚合是有意的（d6-reward §7.8）；只在管理端跑。
	var rows []struct {
		RecipientID int64 `json:"recipient_id"`
		TotalCents  int64 `json:"total_cents"`
		Count       int64 `json:"count"`
	}
	err = public().
		GroupBy(donationrecord.FieldRecipientID).
		Aggregate(
			ent.As(ent.Sum(donationrecord.FieldAmountCents), "total_cents"),
			ent.As(ent.Count(), "count"),
		).
		Scan(ctx, &rows)
	if err != nil {
		return nil, fmt.Errorf("统计排行榜: %w", err)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].TotalCents != rows[j].TotalCents {
			return rows[i].TotalCents > rows[j].TotalCents
		}
		return rows[i].RecipientID < rows[j].RecipientID
	})
	top := in.Top
	if top <= 0 {
		top = 10
	}
	if len(rows) > top {
		rows = rows[:top]
	}
	userIDs := make([]int64, 0, len(rows))
	for _, r := range rows {
		userIDs = append(userIDs, r.RecipientID)
	}
	briefs, err := s.userBriefs(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out.Leaderboard = append(out.Leaderboard, RecipientIncome{
			User:       briefs[r.RecipientID],
			TotalCents: r.TotalCents,
			Count:      r.Count,
		})
	}
	return out, nil
}

// pair 把 Aggregate(...).Ints() 的 [sum, count] 拆开。
func pair(v []int) (int64, int64) {
	if len(v) < 2 {
		return 0, 0
	}
	return int64(v[0]), int64(v[1])
}
