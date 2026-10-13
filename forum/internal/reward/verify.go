package reward

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	ent "forum/internal/ent"
	"forum/internal/ent/donationrecord"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/queue"

	"forum/internal/authz"
)

// Verify 核验一条申报（d6-reward §6.3）。判定顺序：权限 → 开关 → 读行 → 终态 → CAS → 审计 → 通知。
func (s *Service) Verify(ctx context.Context, actor *authz.Actor, publicID string, in VerifyInput) (*Donation, error) {
	if err := requirePerm(actor, authz.PermRewardVerify); err != nil {
		return nil, err
	}
	pid, err := parsePublicID(publicID, "id")
	if err != nil {
		return nil, err
	}
	var out *Donation
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		d, err := s.verifyTx(ctx, tx, actor, pid, in)
		out = d
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// VerifyBatch 是批量核验：一个管理员意图 = 一个事务，逐条 CAS，返回逐条成败。
// 一条重复核验不让另外 19 条一起失败（界面需求 §5.1）。
func (s *Service) VerifyBatch(ctx context.Context, actor *authz.Actor, in BatchVerifyInput) (*BatchResult, error) {
	if err := requirePerm(actor, authz.PermRewardVerify); err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(in.IDs))
	for _, raw := range in.IDs {
		pid, err := parsePublicID(raw, "ids")
		if err != nil {
			return nil, err
		}
		ids = append(ids, pid)
	}
	res := &BatchResult{Results: make([]BatchItem, 0, len(ids))}
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		for i, pid := range ids {
			_, err := s.verifyTx(ctx, tx, actor, pid, VerifyInput{State: in.State, Note: in.Note, IP: in.IP})
			item := BatchItem{ID: in.IDs[i], OK: err == nil}
			if err != nil {
				code, ok := apperrCode(err)
				if !ok {
					// 非业务错误（库故障等）：整批回滚，一条都不留
					return fmt.Errorf("批量核验 %s: %w", in.IDs[i], err)
				}
				item.Code = code
			}
			res.Results = append(res.Results, item)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// verifyTx 是核验的实体：CAS + 审计 + 通知，全部在传进来的事务里。
func (s *Service) verifyTx(ctx context.Context, tx *ent.Tx, actor *authz.Actor, pid uuid.UUID, in VerifyInput) (*Donation, error) {
	row, err := tx.DonationRecord.Query().Where(donationrecord.PublicIDEQ(pid)).Only(ctx)
	if err != nil {
		if isNotFound(err) {
			return nil, apperr.ErrNotFound
		}
		return nil, fmt.Errorf("读申报: %w", err)
	}
	if row.State == StateWithdrawn {
		return nil, ErrInvalidTransition
	}
	if row.State == in.State {
		return nil, ErrAlreadyHandled
	}

	now := s.clk.Now()
	// CAS：state <> 目标态 是幂等的关键——同态重放 0 行，不写第二条审计（§7.2）
	n, err := tx.DonationRecord.Update().
		Where(
			donationrecord.IDEQ(row.ID),
			donationrecord.StateIn(StatePending, StateApproved, StateRejected),
			donationrecord.StateNEQ(in.State),
		).
		SetState(in.State).
		SetVerifiedBy(actor.UserID).
		SetVerifiedAt(now).
		SetUpdatedAt(now).
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("核验申报: %w", err)
	}
	if n == 0 {
		// 并发下对方已经改过了：再判一次是「重放」还是「已撤回」
		cur, err := tx.DonationRecord.Query().Where(donationrecord.IDEQ(row.ID)).Only(ctx)
		if err != nil {
			return nil, fmt.Errorf("回查申报: %w", err)
		}
		if cur.State == StateWithdrawn {
			return nil, ErrInvalidTransition
		}
		return nil, ErrAlreadyHandled
	}

	if err := s.writeAudit(ctx, tx, actor.UserID, "reward.verify", "reward", pid.String(), map[string]any{
		"before": map[string]any{"state": row.State},
		"after":  map[string]any{"state": in.State, "amount_cents": row.AmountCents, "note": in.Note},
	}, in.IP); err != nil {
		return nil, err
	}
	// 通知收款人：与核验同事务，核验回滚则任务也不存在
	if err := s.q.EnqueueTx(ctx, tx, queue.Task{
		Type:    queue.TypeNotifyReward,
		Payload: map[string]any{"id": row.ID},
	}); err != nil {
		return nil, err
	}

	out, err := s.refresh(ctx, tx, pid)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// refresh 在同一事务里读回最新形态，让响应与库一致（改判后 state 必须立刻是新的）。
func (s *Service) refresh(ctx context.Context, tx *ent.Tx, pid uuid.UUID) (*Donation, error) {
	row, err := tx.DonationRecord.Query().Where(donationrecord.PublicIDEQ(pid)).Only(ctx)
	if err != nil {
		return nil, fmt.Errorf("读回申报: %w", err)
	}
	userIDs := []int64{row.DonorID, row.RecipientID}
	if row.VerifiedBy != nil {
		userIDs = append(userIDs, *row.VerifiedBy)
	}
	briefs, err := s.userBriefs(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	d := &Donation{
		ID:          row.PublicID.String(),
		AmountCents: row.AmountCents,
		TxnID:       row.TxnID,
		State:       row.State,
		Note:        row.Note,
		Donor:       briefs[row.DonorID],
		Recipient:   briefs[row.RecipientID],
		VerifiedAt:  row.VerifiedAt,
		CreatedAt:   row.CreatedAt,
	}
	if row.VerifiedBy != nil {
		b := briefs[*row.VerifiedBy]
		d.Verifier = &b
	}
	return d, nil
}
