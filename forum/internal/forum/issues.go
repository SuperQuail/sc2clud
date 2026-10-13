package forum

import (
	"context"
	"strings"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// ---- 读 ----

// ListIssues 是 Issue 列表：TopicPublicID 为空时是**全站聚合**（W3 的反馈页，§7.7）。
//
// 三种排序：updated（默认，走索引）/ created（索引仍是 status 前缀）/ comments（聚合排序，
// **不走索引**，所以只允许首页——带上游标直接 400，不让它变成一条会扫全表的翻页路径）。
func (s *Service) ListIssues(ctx context.Context, actor *authz.Actor, in ListIssuesInput) (*IssuePage, error) {
	status, err := issueStatusDB(in.Status)
	if err != nil {
		return nil, err
	}
	sort, err := parseIssueSort(in.Sort)
	if err != nil {
		return nil, err
	}
	if sort == pgsql.IssueSortComments && in.Cursor != "" {
		return nil, ErrSortUnpageable
	}
	f := pgsql.IssueFilter{Status: status, Kind: in.Kind, Sort: sort, Limit: limitOf(in.Limit)}
	if f.Kind != "" {
		switch f.Kind {
		case "bug", "feature", "difficulty", "other":
		default:
			return nil, invalid("kind", "只能是 bug / feature / difficulty / other")
		}
	}
	if in.TopicPublicID != "" {
		ref, err := s.repo.TopicRef(ctx, in.TopicPublicID, viewerID(actor), canReview(actor))
		if err != nil {
			if err == pgsql.ErrNoRows {
				return nil, ErrTopicNotFound
			}
			return nil, err
		}
		f.TopicID = ref.ID
	}
	if in.Author != "" {
		user, err := s.repo.UserBriefByHandle(ctx, in.Author)
		if err != nil {
			if err == pgsql.ErrNoRows {
				return nil, apperr.New("user.not_found", 404, "用户不存在")
			}
			return nil, err
		}
		f.AuthorID = &user.ID
	}
	if in.AssigneeMe {
		// assignee=me 需要登录：不登录就没有「我」。assignee 传别的值会让这个参数
		// 变成「看别人被指派了什么」的探测口（§7.7），所以只接受 me。
		if _, err := requireActor(actor); err != nil {
			return nil, err
		}
		f.AssigneeID = &actor.UserID
	}
	cursorT, cursorID, err := pageCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	f.CursorT, f.CursorID = cursorT, cursorID

	rows, err := s.repo.ListIssues(ctx, f)
	if err != nil {
		return nil, err
	}
	items := make([]IssueDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, s.issueDTO(r))
	}
	ref := issueCursorRef(sort)
	return &IssuePage{Items: items, NextCursor: nextCursor(rows, f.Limit, ref)}, nil
}

// issueCursorRef 与 SQL 的 ORDER BY 逐字同源：sort=comments 时没有游标（首页专用）。
func issueCursorRef(sort pgsql.IssueSort) func(pgsql.IssueRow) (time.Time, int64) {
	return func(r pgsql.IssueRow) (time.Time, int64) {
		if sort == pgsql.IssueSortCreated {
			return r.CreatedAt, r.ID
		}
		return r.UpdatedAt, r.ID
	}
}

// IssueDetail 是 Issue 详情：卡片 + 正文 HTML。
func (s *Service) IssueDetail(ctx context.Context, actor *authz.Actor, publicID string) (*IssueDetailDTO, error) {
	ref, err := s.repo.IssueRef(ctx, publicID, viewerID(actor), canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrIssueNotFound
		}
		return nil, err
	}
	row, err := s.repo.IssueByID(ctx, ref.ID)
	if err != nil {
		return nil, err
	}
	return &IssueDetailDTO{IssueDTO: s.issueDTO(*row), BodyHTML: row.BodyHTML}, nil
}

// ListIssueComments 是 Issue 的顶层评论（§7.8 Q12，游标按 id）。
func (s *Service) ListIssueComments(ctx context.Context, actor *authz.Actor, issuePublicID string, in PageInput) (*IssueCommentPage, error) {
	ref, err := s.repo.IssueRef(ctx, issuePublicID, viewerID(actor), canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrIssueNotFound
		}
		return nil, err
	}
	limit := limitOf(in.Limit)
	cursorID, err := intCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.IssueComments(ctx, ref.ID, viewerID(actor), cursorID, limit)
	if err != nil {
		return nil, err
	}
	items := make([]IssueCommentDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, issueCommentDTO(r))
	}
	return &IssueCommentPage{Items: items, NextCursor: nextIntCursor(rows, limit, func(r pgsql.IssueCommentRow) int64 { return r.ID })}, nil
}

// ListIssueCommentReplies 是 Issue 评论的楼中楼（与帖子同构）。
func (s *Service) ListIssueCommentReplies(ctx context.Context, actor *authz.Actor, commentPublicID string) ([]IssueCommentDTO, error) {
	ref, err := s.repo.IssueCommentRef(ctx, commentPublicID, viewerID(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrIssueNotFound
		}
		return nil, err
	}
	rows, err := s.repo.IssueCommentReplies(ctx, ref.ID, viewerID(actor))
	if err != nil {
		return nil, err
	}
	out := make([]IssueCommentDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, issueCommentDTO(r))
	}
	return out, nil
}

// ---- 写 ----

// CreateIssue 是提反馈（§7.6）：取号在同一事务里，且取号前先锁主题行让并发提号串行。
func (s *Service) CreateIssue(ctx context.Context, actor *authz.Actor, topicPublicID string, in CreateIssueInput) (*IssueDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermTopicCreate); err != nil {
		return nil, err
	}
	if err := validIssueKind(in.Kind); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(in.Title)
	if title == "" || len([]rune(title)) > 120 {
		return nil, invalid("title", "标题不能为空，且不超过 120 字")
	}
	if strings.TrimSpace(in.BodyMD) == "" {
		return nil, invalid("body_md", "正文不能为空")
	}
	if len(in.ClientToken) > 64 {
		return nil, invalid("client_token", "长度不能超过 64")
	}
	ref, err := s.repo.TopicRef(ctx, topicPublicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrTopicNotFound
		}
		return nil, err
	}
	if ref.Kind != "resource" {
		return nil, ErrNotResource
	}
	if ref.LockedAt != nil {
		return nil, ErrTopicLocked
	}
	if err := s.canSpeak(ctx, actor, ref.BoardID, "reply"); err != nil {
		return nil, err
	}
	html, plain, err := s.render(in.BodyMD)
	if err != nil {
		return nil, err
	}
	now := s.clk.Now().UTC()
	var issueID int64
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		// ① 锁资源帖行：让同一主题的并发提号串行（§7.6 ①）。
		locked, err := pgsql.TopicRefForUpdate(ctx, tx, ref.ID)
		if err != nil {
			return err
		}
		if locked.Kind != "resource" {
			return ErrNotResource
		}
		if locked.LockedAt != nil {
			return ErrTopicLocked
		}
		// ② 取号 + 插入。uq_post_issues_topic_number 是第二道闸。
		id, _, err := pgsql.InsertIssue(ctx, tx, newPublicID(), ref.ID, actor.UserID, in.Kind, title,
			in.BodyMD, html, plain, in.ClientToken, now)
		if err != nil {
			if in.ClientToken != "" && isUniqueViolation(err) {
				id, _, err = s.repo.IssueIDByClientToken(ctx, actor.UserID, in.ClientToken)
				if err != nil {
					return err
				}
				issueID = id
				return nil
			}
			return err
		}
		issueID = id
		return nil
	})
	if err != nil {
		return nil, err
	}
	row, err := s.repo.IssueByID(ctx, issueID)
	if err != nil {
		return nil, err
	}
	d := s.issueDTO(*row)
	return &d, nil
}

// UpdateIssue 是 PATCH /issues/{id}（§7.5）：
// 关 / 开走与锁主题同一类判定，改标题正文走编辑判定，指派走锁判定。
func (s *Service) UpdateIssue(ctx context.Context, actor *authz.Actor, publicID string, in UpdateIssueInput) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	if err := requirePerm(actor, authz.PermTopicEditOwn); err != nil {
		return err
	}
	ref, err := s.repo.IssueRef(ctx, publicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrIssueNotFound
		}
		return err
	}
	editor := canEditTopic(actor, authz.PermTopicEditOwn, authz.PermTopicDeleteAny, ref.AuthorID, ref.BoardID)
	locker := canLockTopic(actor, ref.AuthorID, ref.BoardID)
	if !editor && !locker {
		return apperr.ErrForbidden
	}

	var title, bodyMD, bodyHTML, bodyText, status *string
	if in.Title != nil || in.BodyMD != nil {
		if !editor {
			return apperr.ErrForbidden
		}
	}
	if in.Status != nil {
		if !locker {
			return apperr.ErrForbidden
		}
		st, err := issueStatusDB(*in.Status)
		if err != nil {
			return err
		}
		if st == "" {
			return invalid("status", "只能是 open / closed")
		}
		status = &st
	}
	if in.Title != nil {
		t := strings.TrimSpace(*in.Title)
		if t == "" || len([]rune(t)) > 120 {
			return invalid("title", "标题不能为空，且不超过 120 字")
		}
		title = &t
	}
	if in.BodyMD != nil {
		if strings.TrimSpace(*in.BodyMD) == "" {
			return invalid("body_md", "正文不能为空")
		}
		h, plain, err := s.render(*in.BodyMD)
		if err != nil {
			return err
		}
		bodyMD, bodyHTML, bodyText = in.BodyMD, &h, &plain
	}
	var assigneeID *int64
	clearAssignee := false
	if in.Assignee != nil {
		if !locker {
			return apperr.ErrForbidden
		}
		if *in.Assignee == "" {
			clearAssignee = true
		} else {
			// 指派只能指向真实存在的用户：填一个不存在的 handle → 404（§7.5）。
			u, err := s.repo.UserBriefByHandle(ctx, *in.Assignee)
			if err != nil {
				if err == pgsql.ErrNoRows {
					return apperr.New("user.not_found", 404, "用户不存在")
				}
				return err
			}
			assigneeID = &u.ID
		}
	}
	now := s.clk.Now().UTC()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		return pgsql.UpdateIssue(ctx, tx, ref.ID, title, bodyMD, bodyHTML, bodyText, status, assigneeID, clearAssignee, actor.UserID, now)
	})
}

// CreateIssueComment 是发 Issue 评论（只允许一级楼中楼，与帖子同构）。
func (s *Service) CreateIssueComment(ctx context.Context, actor *authz.Actor, issuePublicID string, in CreateCommentInput) (*IssueCommentDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermTopicCreate); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.BodyMD) == "" {
		return nil, invalid("body_md", "评论不能为空")
	}
	ref, err := s.repo.IssueRef(ctx, issuePublicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrIssueNotFound
		}
		return nil, err
	}
	topic, err := s.repo.TopicRefByID(ctx, ref.TopicID)
	if err != nil {
		return nil, err
	}
	if topic.LockedAt != nil {
		return nil, ErrTopicLocked
	}
	if err := s.canSpeak(ctx, actor, ref.BoardID, "reply"); err != nil {
		return nil, err
	}
	html, _, err := s.render(in.BodyMD)
	if err != nil {
		return nil, err
	}
	var parentID *int64
	if in.ParentID != "" {
		parent, err := s.repo.IssueCommentRef(ctx, in.ParentID, actor.UserID)
		if err != nil {
			if err == pgsql.ErrNoRows {
				return nil, ErrIssueNotFound
			}
			return nil, err
		}
		if parent.IssueID != ref.ID {
			return nil, ErrParentTopic
		}
		if parent.ParentID != nil {
			return nil, ErrParentNested
		}
		parentID = &parent.ID
	}
	now := s.clk.Now().UTC()
	var commentID int64
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		id, err := pgsql.InsertIssueComment(ctx, tx, newPublicID(), ref.ID, actor.UserID, parentID, in.BodyMD, html, now)
		if err != nil {
			return err
		}
		commentID = id
		return nil
	})
	if err != nil {
		return nil, err
	}
	row, err := s.repo.IssueCommentByID(ctx, commentID, actor.UserID)
	if err != nil {
		return nil, err
	}
	d := issueCommentDTO(*row)
	return &d, nil
}

func parseIssueSort(s string) (pgsql.IssueSort, error) {
	switch s {
	case "", "updated":
		return pgsql.IssueSortUpdated, nil
	case "created":
		return pgsql.IssueSortCreated, nil
	case "comments":
		return pgsql.IssueSortComments, nil
	default:
		return "", invalid("sort", "只能是 updated / created / comments")
	}
}

// validIssueKind 是四类 kind 的 CHECK（界面施工 §3.2）。
func validIssueKind(k string) error {
	switch k {
	case "bug", "feature", "difficulty", "other":
		return nil
	default:
		return invalid("kind", "只能是 bug / feature / difficulty / other")
	}
}
