package report

import (
	"context"
	"fmt"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/report"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	platformdb "forum/internal/platform/db"
	"forum/internal/platform/idgen"
	"forum/internal/report/pgsql"
)

// Create 提交举报（POST /api/v1/reports）。
//
// 幂等：同一人对同一目标的**未处理**举报只留一条（uq_reports_once 这个部分唯一索引），
// 重复提交返回 200 + 既有那条（拍板 §8.11 U5：连点两次不该看到错误，他的目的已经达成）。
func (s *Service) Create(ctx context.Context, actor *authz.Actor, in CreateReportInput) (*Report, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	info, exists, err := s.targets.ResolveTarget(ctx, in.TargetType, in.TargetID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, apperr.ErrNotFound
	}
	// U4：自己的内容自己删就行，举报自己是队列噪音
	if info.AuthorID == actor.UserID {
		return nil, apperr.Invalid(map[string]string{"target_id": "不能举报自己的内容"})
	}

	pid, err := idgen.NewPublicID()
	if err != nil {
		return nil, fmt.Errorf("生成举报 id: %w", err)
	}
	now := s.clk.Now()

	var out Report
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		txq := pgsql.NewTx(tx)
		id, created, err := txq.InsertReport(ctx, pgsql.NewReport{
			PublicID: pid.String(), TargetType: in.TargetType, TargetID: info.InternalID,
			Reason: in.Reason, Detail: in.Detail, ReporterID: actor.UserID, Now: now,
		})
		if err != nil {
			return err
		}
		row, err := tx.Report.Query().Where(report.IDEQ(id)).Only(ctx)
		if err != nil {
			return fmt.Errorf("读举报: %w", err)
		}
		n, err := txq.CountOpenForTarget(ctx, in.TargetType, info.InternalID)
		if err != nil {
			return err
		}
		built, err := s.view(ctx, row, info, n, map[int64]UserBrief{})
		if err != nil {
			return err
		}
		built.Created = created
		out = built

		// 重复举报（复用既有那条）不再触发复核：那是上一轮的事
		if !created || in.TargetType != TargetTopic || s.review == nil {
			return nil
		}
		th1, th2 := s.thresholds(ctx)
		// 只在**越过阈值的那一刻**触发：刚插入的这一条一定被算进 n，所以 n-1 就是「这次之前有几个」。
		// 用「越过」而不是「n >= 阈值」，是为了不在第 4、6、7… 条上重复触发同一轮复核
		//（d7 用 review:report:<topic>:<轮次> 的 unique_key 去重，那需要 review_events，本域没有）。
		prev := n - 1
		var human bool
		switch {
		case prev < th2 && n >= th2:
			human = true // 到第二阈值：直接进人工，不再调 AI（拍板 §10.4，防举报风暴打爆额度）
		case prev < th1 && n >= th1:
			human = false
		default:
			return nil
		}
		return s.review.TriggerReportReview(ctx, tx, ReportReviewInput{
			TopicID: info.InternalID, OpenReports: n, Human: human,
		})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListMine 是 GET /me/reports：我发出的举报（本人语义，不挂权限点）。
func (s *Service) ListMine(ctx context.Context, actor *authz.Actor, in CursorInput) (*ReportPage, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	cur, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	q := s.db.Report.Query().Where(report.ReporterIDEQ(actor.UserID))
	if cur != nil {
		q = q.Where(report.Or(
			report.CreatedAtLT(cur.T),
			report.And(report.CreatedAtEQ(cur.T), report.IDLT(cur.ID)),
		))
	}
	rows, err := q.Order(ent.Desc(report.FieldCreatedAt), ent.Desc(report.FieldID)).Limit(limit + 1).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读我的举报: %w", err)
	}
	return s.page(ctx, rows, limit)
}

// ListQueue 是 GET /admin/reports：管理员队列（?state=&target_type=&limit=&cursor=）。
func (s *Service) ListQueue(ctx context.Context, actor *authz.Actor, in QueueInput) (*ReportPage, error) {
	if err := requirePerm(actor, authz.PermReportHandle); err != nil {
		return nil, err
	}
	cur, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	q := s.db.Report.Query()
	if in.State != "" {
		q = q.Where(report.StateEQ(in.State))
	}
	if in.TargetType != "" {
		q = q.Where(report.TargetTypeEQ(in.TargetType))
	}
	if cur != nil {
		q = q.Where(report.Or(
			report.CreatedAtLT(cur.T),
			report.And(report.CreatedAtEQ(cur.T), report.IDLT(cur.ID)),
		))
	}
	rows, err := q.Order(ent.Desc(report.FieldCreatedAt), ent.Desc(report.FieldID)).Limit(limit + 1).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读举报队列: %w", err)
	}
	return s.page(ctx, rows, limit)
}

// Handle 处理一条举报（PATCH /admin/reports/{id}）。
//
// 判定顺序（d6 §2.2）：权限 → 读行（404）→ 终态 409 → CAS（0 行再 409）→ 审计。
func (s *Service) Handle(ctx context.Context, actor *authz.Actor, publicID string, in HandleInput) (*Report, error) {
	if err := requirePerm(actor, authz.PermReportHandle); err != nil {
		return nil, err
	}
	if in.State == stateHandled && in.Note == "" {
		// 「已处理」不写做了什么等于没处理（d6 §6.6）
		return nil, apperr.Invalid(map[string]string{"note": "标记已处理时必须写处理说明"})
	}
	pid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, apperr.ErrNotFound
	}

	var out Report
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.Report.Query().Where(report.PublicIDEQ(pid)).Only(ctx)
		if ent.IsNotFound(err) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("读举报: %w", err)
		}
		if row.State != stateOpen {
			return ErrAlreadyHandled
		}
		now := s.clk.Now()
		n, err := pgsql.NewTx(tx).HandleCAS(ctx, publicID, in.State, actor.UserID, in.Note, now)
		if err != nil {
			return err
		}
		if n == 0 {
			// 读行之后、CAS 之前有人处理掉了（并发重放）：给确定的 409，且不写第二份审计
			return ErrAlreadyHandled
		}
		if err := s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionReportHandle,
			TargetType: "report", TargetID: publicID,
			Detail: map[string]any{"before": map[string]any{"state": row.State},
				"after": map[string]any{"state": in.State, "handle_note": in.Note}},
			IP: in.IP,
		}); err != nil {
			return err
		}
		updated, err := tx.Report.Query().Where(report.PublicIDEQ(pid)).Only(ctx)
		if err != nil {
			return fmt.Errorf("读举报: %w", err)
		}
		info, err := s.targets.TargetInfo(ctx, updated.TargetType, updated.TargetID)
		if err != nil {
			return fmt.Errorf("读被举报目标: %w", err)
		}
		count, err := pgsql.NewTx(tx).CountOpenForTarget(ctx, updated.TargetType, updated.TargetID)
		if err != nil {
			return err
		}
		built, err := s.view(ctx, updated, info, count, map[int64]UserBrief{})
		if err != nil {
			return err
		}
		out = built
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// HandleBatch 批量处理（POST /admin/reports/batch）：一个事务 + 逐条 CAS + 逐条结果。
func (s *Service) HandleBatch(ctx context.Context, actor *authz.Actor, in BatchHandleInput) (*BatchResult, error) {
	if err := requirePerm(actor, authz.PermReportHandle); err != nil {
		return nil, err
	}
	if in.State == stateHandled && in.Note == "" {
		return nil, apperr.Invalid(map[string]string{"note": "标记已处理时必须写处理说明"})
	}
	return s.handleBatch(ctx, actor, in.IDs, in.State, in.Note, in.IP)
}

// page 裁掉多取的那一条并算出 next_cursor。
func (s *Service) page(ctx context.Context, rows []*ent.Report, limit int) (*ReportPage, error) {
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	items, err := s.views(ctx, rows)
	if err != nil {
		return nil, err
	}
	return &ReportPage{Items: items, NextCursor: next}, nil
}
