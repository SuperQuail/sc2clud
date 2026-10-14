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
// 检索与筛选（拍板 08 · J5 = 界面施工 §3.1 + §3.1.1）：
//
//	q       标题 + 正文，**不分词**（ILIKE '%q%'）。中文两字词靠这条就能命中：
//	        PG 的 FTS 需要分词器，而这一版的 issue 量级与需求（"「卡关」搜得到"）
//	        都不值得引入它（§3.1 的 q 就是「复用 PG 侧的检索能力」这一条）。
//	status  open | closed（空 = 不限，换算在 issueStatusDB，只有那一处）
//	kind    issue_kinds 表的值域（拍板 08 · J6）—— 不认识的直接 400，不静默当不限
//	author  handle（空 = 不限）
//	assignee 只接受 me（别的值 = 探测口，§7.7）
//
// 四种排序：updated（默认，走索引）/ created（新→旧）/ old（旧→新，同一列的另一个方向）/
// comments（聚合排序，**不走索引**，所以只允许首页 —— 带上游标直接 400，
// 不让它变成一条会扫全表的翻页路径）。
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
	q := strings.TrimSpace(in.Q)
	// 检索词是 SQL LIKE 的**模式**，% 与 _ 是通配符：不转义的话「%」会命中全部
	// （看起来像「搜索生效了」），而「_」会变成任意单字符。**用户输入不是模式**。
	if strings.ContainsAny(q, "%_\\") {
		return nil, invalid("q", "检索词不能包含 % _ \\ 这些字符")
	}
	if len([]rune(q)) > maxIssueQ {
		return nil, invalid("q", "最多 100 字")
	}
	f := pgsql.IssueFilter{Status: status, Kind: in.Kind, Q: q, Sort: sort, Limit: limitOf(in.Limit)}
	// 值域来自 issue_kinds 表（拍板 08 · J6），**不是代码里的封闭枚举**。
	// 不认识的 kind 直接 400 而不是「不过滤」：静默当不过滤会让前端以为筛选生效了。
	if f.Kind != "" {
		ok, err := s.repo.IssueKindExists(ctx, s.db, f.Kind)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, s.invalidKind(ctx)
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
	// sort=old 是升序：空游标的哨兵要取**最小值**，否则第一页恒假、返回零行
	// （见 cursor.go 的 sentinelTimeAsc）。
	if in.Cursor == "" && sort == pgsql.IssueSortOld {
		cursorT = sentinelTimeAsc
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

// IssueKinds 是当前可用的 Issue 类型值域（拍板 08 · J6）。
// 前端用它渲染「新建 Issue」的四个入口与筛选下拉 —— **值域只有这一处**，
// 所以加一类之后界面不需要发版（它读的是端点，不是常量表）。
func (s *Service) IssueKinds(ctx context.Context) ([]string, error) {
	return s.repo.IssueKinds(ctx)
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
	// 踩数的可见性（J3）：管理员及以上，或**这条评论是我的**。
	showDislike := s.ShowDislikeCount(actor)
	items := make([]IssueCommentDTO, 0, len(rows))
	for _, r := range rows {
		d := issueCommentDTO(r)
		hideCommentDislike(&d, showDislike || r.Author.ID == viewerID(actor))
		items = append(items, d)
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
	showDislike := s.ShowDislikeCount(actor)
	out := make([]IssueCommentDTO, 0, len(rows))
	for _, r := range rows {
		d := issueCommentDTO(r)
		hideCommentDislike(&d, showDislike || r.Author.ID == viewerID(actor))
		out = append(out, d)
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
	// 值域来自 issue_kinds（拍板 08 · J6）。在事务之外先查一次：拿到 400 就不必开事务；
	// 事务里 post_issues.kind 的外键是第二道闸（并发删类型时兜底）。
	kindOK, err := s.repo.IssueKindExists(ctx, s.db, in.Kind)
	if err != nil {
		return nil, err
	}
	if !kindOK {
		return nil, s.invalidKind(ctx)
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
	// **不在这里判 topic.edit.own**（2026-10-14 修）：能改这条 Issue 的人不止一种，
	// 全局权限点判不掉「哪种人做哪种事」——权限点的判据在下面对应的分支里各判一次：
	//   · 改标题 / 正文 → canEditTopic（own / delete.any / board.moderate）；
	//   · 开关（关 / 开）→ canCloseIssue（J8：作者 / 版主 / 管理员及以上 / Issue 发布者）；
	//   · 指派         → canCloseIssue 的同一档。
	// 原来第一行就 requirePerm(topic.edit.own)，后果是**持 topic.lock 的管理员关不掉 Issue**
	// （403），而 J8 明确要求他能关 —— 一条路由级中间件把 service 的四档判定压成了一档。
	ref, err := s.repo.IssueRef(ctx, publicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrIssueNotFound
		}
		return err
	}
	editor := canEditTopic(actor, authz.PermTopicEditOwn, authz.PermTopicDeleteAny, ref.AuthorID, ref.BoardID)
	// J8：能关 Issue 的人 = **作者**（主题作者）/ 版主 / 管理员及以上 / **Issue 发布者**（ref.AuthorID）。
	locker := canCloseIssue(actor, ref.TopicAuthorID, ref.BoardID, &ref.AuthorID)
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
	// 新评论的踩数必然是 0，判据仍然走同一条规则（列表与 201 的响应不能两套）。
	hideCommentDislike(&d, s.ShowDislikeCount(actor) || row.Author.ID == actor.UserID)
	return &d, nil
}

// maxIssueQ 是检索词上限（防止一个超长 ILIKE 被滥用成扫表工具）。
const maxIssueQ = 100

// parseIssueSort 是 ?sort= 的值域（§3.1 的 new|old|comments + 默认 updated）。
// 四个名字都收：new 与 created 同义（前者是需求里的写法，后者是已发货的名字）——
// 同一个方向只留一个实现，别名只是入口。
func parseIssueSort(s string) (pgsql.IssueSort, error) {
	switch s {
	case "", "updated":
		return pgsql.IssueSortUpdated, nil
	case "created", "new":
		return pgsql.IssueSortCreated, nil
	case "old":
		return pgsql.IssueSortOld, nil
	case "comments":
		return pgsql.IssueSortComments, nil
	default:
		return "", invalid("sort", "只能是 updated / new / old / comments")
	}
}

// invalidKind 造「kind 不认识」的 400，并把**当前可用值域**列出来（拍板 08 · J6）。
//
// 为什么带上值域：值域不再写死在代码里，所以错误信息不能写死 ——
// 「只能是 bug / feature / difficulty / other」这句话在加了一类之后就是假话，
// 而这类假话正是本仓库最容易留下的东西（参见交接单 §5 的「过期注释」）。
// 查值域失败时不因此变成 500：错误信息拿不到就拿不到，400 本身是对的。
func (s *Service) invalidKind(ctx context.Context) error {
	kinds, err := s.repo.IssueKinds(ctx)
	if err != nil || len(kinds) == 0 {
		return invalid("kind", "不是当前可用的 Issue 类型")
	}
	return invalid("kind", "只能是 "+strings.Join(kinds, " / "))
}
