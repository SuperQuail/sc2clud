package forum

import (
	"context"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// 管理端的 Issue 归档（0062_issue_archive）。三件事：
//   - 列表要能拿到**已归档**的（公共读口一律排除它们）；
//   - 归档 / 恢复各一条动作，写审计；
//   - 权限点用既有的 post.review（不新造：RBAC 是 24 点，加一个要动种子迁移）。
//
// 「已归档 = 404」那一半在 issues.go 的 LoadIssueRef 里（公共读口的那三条路），不在这里。

// 审计动作名（detail 带 reason；AI 归档的那条由 aireview 写，action 同值、source=ai）。
const (
	actionIssueArchive = "issue.archive"
	actionIssueRestore = "issue.restore"
	// archivedAll 是「已归档 + 未归档」的哨兵值。
	// 为什么不直接用空串：空串在 filter 里是「缺省 = 只看未归档」，两者必须分得开，
	// 而 pgsql 的 WHERE 只认 '' / '0' / '1' 三种（NULL = 不过滤）。
	archivedAll = "all"
)

// issueArchivedDB 归一化 ?archived= 并换算成 pgsql 认的三个值。
// 缺省（空）与 "0" 都是只看未归档 —— 与公共读口一致（管理端打开就先看现在有什么）。
func issueArchivedDB(s string) (string, error) {
	switch s {
	case "", "0":
		return "0", nil
	case "1":
		return "1", nil
	case archivedAll:
		// 空串 = 不过滤（SELECT 里的 $4 变 NULL）——**这里不是缺省**，缺省已在上一档返回。
		return "", nil
	default:
		return "", invalid("archived", "只能是 0 / 1 / all")
	}
}

// ListAdminIssues 是 GET /admin/issues（0062）。
func (s *Service) ListAdminIssues(ctx context.Context, actor *authz.Actor, in AdminIssueInput) (*IssueAdminPage, error) {
	// 权限在 service 也判一次（队列 / CLI 不走路由，拍板 §5.3）。
	// 先判身份再判权限点：actor 为 nil（游客）时它的权限集也是 nil，
	// requirePerm 直查 Perms 会解引用空指针（sourceActor 空值 + 一张 nil map）。
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermPostReview); err != nil {
		return nil, err
	}
	status, err := issueStatusDB(in.Status)
	if err != nil {
		return nil, err
	}
	archived, err := issueArchivedDB(in.Archived)
	if err != nil {
		return nil, err
	}
	q := in.Q
	if len([]rune(q)) > maxIssueQ {
		return nil, invalid("q", "最多 100 字")
	}
	f := pgsql.IssueAdminFilter{
		Status: status, Kind: in.Kind, Q: q, Archived: archived, Limit: limitOf(in.Limit),
	}
	if f.Kind != "" {
		ok, err := s.repo.IssueKindExists(ctx, s.db, f.Kind)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, s.invalidKind(ctx)
		}
	}
	// 游标是 (updated_at DESC, id DESC) 的位置：本方法只有这一种排序。
	f.CursorT, f.CursorID, err = pageCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.IssueAdminList(ctx, f)
	if err != nil {
		return nil, err
	}
	items := make([]IssueAdminDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, s.issueAdminDTO(r))
	}
	// counts 与列表共用同一组筛选，**但不带 archived**：三档计数是「库里各有多少」，
	// 要一直看得见 —— 跟着当前 tab 走的话，切到「已归档」那一档时「未归档 N」会变成 0。
	cf := f
	cf.Archived = ""
	counts, err := s.repo.IssueAdminCounts(ctx, cf)
	if err != nil {
		return nil, err
	}
	return &IssueAdminPage{
		Items: items, Counts: counts,
		NextCursor: nextCursor(rows, f.Limit, func(r pgsql.IssueAdminRow) (time.Time, int64) { return r.UpdatedAt, r.ID }),
	}, nil
}

// ArchiveIssue 是 POST /admin/issues/{id}/archive。
//
// 幂等：已经归档的那条返回 0 行 → 不写第二条审计，也不报错（管理员连点两次的目的已经达成，
// 与举报幂等是同一个取舍）。不存在 / 非 uuid → 404（与公共详情同形）。
func (s *Service) ArchiveIssue(ctx context.Context, actor *authz.Actor, publicID string, in ArchiveIssueInput) error {
	if err := requirePerm(actor, authz.PermPostReview); err != nil {
		return err
	}
	return s.setIssueArchived(ctx, actor, publicID, true, in.Reason, in.IP)
}

// RestoreIssue 是 POST /admin/issues/{id}/restore。恢复是归档的逆：把三列清回未归档。
func (s *Service) RestoreIssue(ctx context.Context, actor *authz.Actor, publicID string) error {
	if err := requirePerm(actor, authz.PermPostReview); err != nil {
		return err
	}
	return s.setIssueArchived(ctx, actor, publicID, false, "", "")
}

// setIssueArchived 是归档 / 恢复的唯一实现（两条路只差一个 UPDATE 与一个 action）。
func (s *Service) setIssueArchived(ctx context.Context, actor *authz.Actor, publicID string,
	archive bool, reason, ip string) error {
	// 形状先校验：非 uuid 送进 SQL 会撞 22P02 → 500。服务层也判一次 ——
	// 路由上的 PathGuard 是第一道，但 service 层是被 CLI / 队列复用的那一层（report.Handle 同例）。
	if _, err := idgen.ParsePublicID(publicID); err != nil {
		return ErrIssueNotFound
	}
	ref, err := s.repo.IssueRef(ctx, publicID, actor.UserID, true)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrIssueNotFound
		}
		return err
	}
	now := s.clk.Now().UTC()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		var n int64
		var err error
		if archive {
			n, err = pgsql.ArchiveIssue(ctx, tx, ref.ID, &actor.UserID, reason, now)
		} else {
			n, err = pgsql.RestoreIssue(ctx, tx, ref.ID, now)
		}
		if err != nil {
			return err
		}
		if n == 0 {
			// 状态已经是目标态：幂等成功，但不写第二份审计（审计记的是「发生过什么」，
			// 重复按一次的第二次并没有发生任何事）。
			return nil
		}
		action, detail := actionIssueRestore, map[string]any{}
		if archive {
			action, detail = actionIssueArchive, map[string]any{"reason": reason}
		}
		// target_id 存对外 id（audit_logs.target_id 是 varchar，0003_authz 的约定）。
		return pgsql.InsertIssueAudit(ctx, tx, actor.UserID, action, ref.PublicID, detail, now)
	})
}

// LoadIssueRef 是公共读口（帖内列表 / 全局列表 / 详情 / 评论）取一条 Issue Ref 的唯一入口。
// 它多做的唯一一件事：**已归档的 Issue 对不持 post.review 的人 = 404**（与不存在同形）。
//
// 为什么不把 archived_at IS NULL 压进 IssueRef 的 WHERE：那样管理员也拿不到它，
// 而「归档只在管理后台可见且可恢复」这条要求里，管理员看得见是另一半。
// 为什么是 404 不是 403：403 等于告诉对方「它存在，只是被藏了」—— 那正是要避免的泄漏。
func (s *Service) LoadIssueRef(ctx context.Context, actor *authz.Actor, publicID string) (*pgsql.IssueRef, error) {
	ref, err := s.repo.IssueRef(ctx, publicID, viewerID(actor), canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrIssueNotFound
		}
		return nil, err
	}
	if ref.ArchivedAt != nil && !canReview(actor) {
		return nil, ErrIssueNotFound
	}
	return ref, nil
}
