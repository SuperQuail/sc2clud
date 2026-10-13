package reward

import (
	"context"
	"fmt"

	ent "forum/internal/ent"
	"forum/internal/ent/donationrecord"
	"forum/internal/ent/paymentchannel"
	"forum/internal/ent/topic"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"

	"forum/internal/authz"
)

// CreateDonation 是用户自报一笔赞赏（d6-reward §6.1）。没有幂等键：同一个人给同一个人打赏两次是合法的。
func (s *Service) CreateDonation(ctx context.Context, actor *authz.Actor, in CreateDonationInput) (*Donation, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	if !s.enabled(ctx) {
		return nil, ErrDisabled
	}

	recipientID, err := s.users.IDByHandle(ctx, in.ToHandle)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	if recipientID == actor.UserID {
		return nil, apperr.Invalid(map[string]string{"to_handle": "不能给自己打赏"})
	}
	rb, err := s.users.Basic(ctx, recipientID)
	if err != nil {
		return nil, fmt.Errorf("读收款人画像 %d: %w", recipientID, err)
	}
	if rb.Status != "active" {
		// 封号用户不收赞赏，且不泄露其状态
		return nil, apperr.ErrNotFound
	}

	var postID *int64
	if in.PostID != "" {
		pid, err := parsePublicID(in.PostID, "post_id")
		if err != nil {
			return nil, err
		}
		t, err := s.db.Topic.Query().Where(topic.PublicIDEQ(pid)).Only(ctx)
		if err != nil {
			if isNotFound(err) {
				return nil, apperr.ErrNotFound
			}
			return nil, fmt.Errorf("读帖子: %w", err)
		}
		if t.Visibility != "normal" || t.AuthorID != recipientID {
			// 在别人帖子里给第三者打赏是数据错；已隐藏/已删的帖子也不能挂新申报
			return nil, apperr.Invalid(map[string]string{"post_id": "帖子不存在或作者不是收款人"})
		}
		postID = &t.ID
	}

	var channelID *int64
	if in.ChannelID != "" {
		cid, err := parsePublicID(in.ChannelID, "channel_id")
		if err != nil {
			return nil, err
		}
		c, err := s.db.PaymentChannel.Query().Where(paymentchannel.PublicIDEQ(cid)).Only(ctx)
		if err != nil {
			if isNotFound(err) {
				return nil, apperr.ErrNotFound
			}
			return nil, fmt.Errorf("读收款码: %w", err)
		}
		if c.UserID != recipientID {
			// 这张码不是收款人的：它只记录「当时展示的是哪张码」
			return nil, apperr.Invalid(map[string]string{"channel_id": "收款码不属于该用户"})
		}
		channelID = &c.ID
	}

	publicID, err := idgen.NewPublicID()
	if err != nil {
		return nil, fmt.Errorf("生成对外 id: %w", err)
	}
	now := s.clk.Now()
	row, err := s.db.DonationRecord.Create().
		SetPublicID(publicID).
		SetDonorID(actor.UserID).
		SetRecipientID(recipientID).
		SetAmountCents(in.AmountCents).
		SetTxnID(in.TxnID).
		SetNillablePostID(postID).
		SetNillableChannelID(channelID).
		SetState(StatePending).
		SetNote(in.Note).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("建申报: %w", err)
	}
	views, err := s.viewDonations(ctx, []*ent.DonationRecord{row})
	if err != nil {
		return nil, err
	}
	return &views[0], nil
}

// ListMyDonations 只返回自己发出的申报，不过滤 state（我自己当然看得到全部）。
func (s *Service) ListMyDonations(ctx context.Context, actor *authz.Actor, in CursorInput) (*DonationPage, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	cur, err := s.decode(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	q := s.db.DonationRecord.Query().Where(donationrecord.DonorIDEQ(actor.UserID))
	rows, err := before(cur)(q).
		Order(ent.Desc(donationrecord.FieldCreatedAt), ent.Desc(donationrecord.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读我发出的申报: %w", err)
	}
	return s.page(ctx, rows, limit)
}

// ListUserDonations 是给别人看的公开记录：只 approved，且双方都同意公开（d6-reward §6.4）。
func (s *Service) ListUserDonations(ctx context.Context, actor *authz.Actor, in UserDonationsInput) (*DonationPage, error) {
	if !s.enabled(ctx) {
		return &DonationPage{Items: []Donation{}}, nil
	}
	userID, err := s.users.IDByHandle(ctx, in.Handle)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	b, err := s.users.Basic(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("读用户画像 %d: %w", userID, err)
	}
	if b.Status != "active" {
		return nil, apperr.ErrNotFound
	}
	cur, err := s.decode(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)

	// 收款人必须公开；打赏人是否公开逐行判（一个开关去授权别人的数据公开是错的）
	show, err := s.publicRecipients(ctx, s.db.UserDonationSetting.Query(), []int64{userID})
	if err != nil {
		return nil, err
	}
	if !show[userID] {
		return &DonationPage{Items: []Donation{}}, nil
	}

	q := s.db.DonationRecord.Query().Where(
		donationrecord.RecipientIDEQ(userID),
		donationrecord.StateEQ(StateApproved),
	)
	rows, err := before(cur)(q).
		Order(ent.Desc(donationrecord.FieldCreatedAt), ent.Desc(donationrecord.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读公开打赏记录: %w", err)
	}
	page, err := s.page(ctx, rows, limit)
	if err != nil {
		return nil, err
	}
	// page 裁掉多余的一行之后，再按「打赏人也同意公开」逐行过滤——私有行不入 DTO
	donors, err := s.publicDonors(ctx, s.db.UserDonationSetting.Query(), dedup(rows, func(r *ent.DonationRecord) int64 { return r.DonorID }))
	if err != nil {
		return nil, err
	}
	publicRows := make([]*ent.DonationRecord, 0, len(rows))
	for _, r := range rows {
		if donors[r.DonorID] {
			publicRows = append(publicRows, r)
		}
	}
	if len(publicRows) == len(rows) {
		return page, nil
	}
	items, err := s.viewDonations(ctx, publicRows)
	if err != nil {
		return nil, err
	}
	return &DonationPage{Items: items, NextCursor: page.NextCursor}, nil
}

// WithdrawDonation 只有 donor 本人能撤自己的 pending；重复撤回 204（幂等）。
func (s *Service) WithdrawDonation(ctx context.Context, actor *authz.Actor, publicID string) error {
	if actor == nil || actor.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	pid, err := parsePublicID(publicID, "id")
	if err != nil {
		return err
	}
	now := s.clk.Now()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		// conditional UPDATE：只动 pending，且只动自己的
		n, err := tx.DonationRecord.Update().
			Where(
				donationrecord.PublicIDEQ(pid),
				donationrecord.DonorIDEQ(actor.UserID),
				donationrecord.StateEQ(StatePending),
			).
			SetState(StateWithdrawn).
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			return fmt.Errorf("撤回申报: %w", err)
		}
		if n > 0 {
			return s.writeAudit(ctx, tx, actor.UserID, "reward.withdraw", "reward",
				pid.String(),
				map[string]any{"before": map[string]any{"state": StatePending}, "after": map[string]any{"state": StateWithdrawn}},
				"")
		}
		// 0 行：区分「不存在 / 不是我的」404、「已撤回」幂等 204、「已核验」403
		row, err := tx.DonationRecord.Query().Where(donationrecord.PublicIDEQ(pid)).Only(ctx)
		if err != nil {
			if isNotFound(err) {
				return apperr.ErrNotFound
			}
			return fmt.Errorf("回查申报: %w", err)
		}
		if row.DonorID != actor.UserID {
			return apperr.ErrNotFound // 不泄露存在性
		}
		switch row.State {
		case StateWithdrawn:
			return nil // 目的已达成
		default:
			return apperr.ErrForbidden.WithMsg("已核验的申报不能撤回")
		}
	})
}

// ListQueue 是管理侧核验队列，永远返回全部（管理员本来就在核验这些数据）。
func (s *Service) ListQueue(ctx context.Context, actor *authz.Actor, in QueueInput) (*DonationPage, error) {
	if err := requirePerm(actor, authz.PermRewardVerify); err != nil {
		return nil, err
	}
	cur, err := s.decode(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	q := s.db.DonationRecord.Query()
	if in.State != "" {
		q = q.Where(donationrecord.StateEQ(in.State))
	}
	rows, err := before(cur)(q).
		Order(ent.Desc(donationrecord.FieldCreatedAt), ent.Desc(donationrecord.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读核验队列: %w", err)
	}
	return s.page(ctx, rows, limit)
}
