package forum

import (
	"context"
	"strings"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"
	"forum/internal/platform/queue"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// ---- 读：分区 ----

// ListBoards 是左栏的分区列表。三个统计现算（§3.3 Q2e），没有计数列。
func (s *Service) ListBoards(ctx context.Context, actor *authz.Actor) ([]BoardDTO, error) {
	rows, err := s.repo.Boards(ctx, s.todayStart(), nil, nil)
	if err != nil {
		return nil, err
	}
	out := make([]BoardDTO, 0, len(rows))
	for _, b := range rows {
		out = append(out, boardDTO(b))
	}
	return out, nil
}

// BoardBySlug 是分区详情。归档分区的读是允许的（只是不能发帖）。
func (s *Service) BoardBySlug(ctx context.Context, slug string) (*BoardDTO, error) {
	row, err := s.repo.BoardBySlug(ctx, slug, s.todayStart())
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrBoardNotFound
		}
		return nil, err
	}
	d := boardDTO(*row)
	return &d, nil
}

func boardDTO(b pgsql.BoardRow) BoardDTO {
	return BoardDTO{
		ID: b.ID, Slug: b.Slug, Name: b.Name, Description: b.Description,
		CoverHash: deref(b.CoverHash), ACLEnabled: b.ACLEnabled,
		MinPostLevel: b.MinPostLevel, MinReplyLevel: b.MinReplyLevel,
		TopicCount: b.TopicCount, PostCount: b.PostCount, TodayCount: b.TodayCount,
	}
}

// DefaultSiteTZ 是站点时区的兜底（D7）：没配置时按老行为走。
// 老实现把 UTC+8 硬编码在 todayStart 里，于是「换时区」只能改代码。
//
// 导出只是为了测试能按名字解析它。**同一份默认值在 config 包也有一份**
// （config.DefaultTimezone）：业务域不 import config，两边同值只能靠评审看住 ——
// 配置层永远会显式传值，兜底只在没接线时生效，所以漂移的实际影响面为零。
const DefaultSiteTZ = "Asia/Shanghai"

// siteTZ 解析配置里的 IANA 名字。解析不了就兜底默认值，**不让进程起不来**：
// 时区只影响「今日」这一个统计，而配置层（config.Validate）已经在启动时挡过非法值。
func siteTZ(loc *time.Location) *time.Location {
	if loc != nil {
		return loc
	}
	fallback, err := time.LoadLocation(DefaultSiteTZ)
	if err != nil {
		return time.UTC
	}
	return fallback
}

// todayStart 是「今日零点」：服务端按**站点时区**算好再传进 SQL。
// 在 SQL 里用 now() + date_trunc 就是第二处时区实现（§3.3 Q2e 的注）。
// 返回 UTC 瞬间 —— pgsql 那边统一 .UTC() 之后再进 timestamptz 比较（D7）。
func (s *Service) todayStart() time.Time {
	n := s.clk.Now().In(s.tz)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, s.tz)
}

// ---- 读：主题列表 ----

// ListTopics 是首页 / 分区页 / 精华标签的列表（§3.2、§3.3）。
func (s *Service) ListTopics(ctx context.Context, actor *authz.Actor, in ListTopicsInput) (*TopicPage, error) {
	sort, err := parseTopicSort(in.Sort)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	f := pgsql.TopicFilter{Kind: in.Kind, Sort: sort, Limit: limit, ViewerID: viewerID(actor)}
	// 游标的编码随排序键走：三种时间序用 (时间, id)，最热用 (score, id)（见 forum/cursor.go 的 hotCursor）。
	if sort == pgsql.SortHot {
		score, id, err := hotPageCursor(in.Cursor)
		if err != nil {
			return nil, err
		}
		f.CursorScore, f.CursorID = score, id
	} else {
		cursorT, cursorID, err := pageCursor(in.Cursor)
		if err != nil {
			return nil, err
		}
		f.CursorT, f.CursorID = cursorT, cursorID
	}
	// 精华标签走索引 (f)，与默认流不是同一条路径（§3.3 Q2c）。
	featured := in.Kind == "featured"
	if in.Board != "" {
		board, err := s.repo.BoardBySlug(ctx, in.Board, s.todayStart())
		if err != nil {
			if err == pgsql.ErrNoRows {
				return nil, ErrBoardNotFound
			}
			return nil, err
		}
		id := board.ID
		f.BoardID = &id
	} else if featured {
		// 精华是全站标签：没有分区就没有索引可走（idx_topics_featured 没有 board_id 前缀）。
		return nil, invalid("board", "精华标签需要指定分区")
	}
	if featured {
		f.Kind = ""
	}
	rows, err := s.repo.ListTopics(ctx, f, featured)
	if err != nil {
		return nil, err
	}
	items := make([]TopicCardDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, s.topicCard(r))
	}
	if sort == pgsql.SortHot {
		return &TopicPage{
			Items: items, Sort: "hot",
			NextCursor: hotNextCursor(rows, limit),
		}, nil
	}
	col := "last_reply_at"
	if sort == pgsql.SortNew {
		col = "created_at"
	}
	return &TopicPage{Items: items, NextCursor: nextCursor(rows, limit, topicCursorRef(col))}, nil
}

// ListPinned 是置顶区块：单独一条查询、不进游标、不翻页（§3.3 Q2b）。
func (s *Service) ListPinned(ctx context.Context, boardID int64) ([]TopicBriefDTO, error) {
	rows, err := s.repo.ListPinned(ctx, boardID)
	if err != nil {
		return nil, err
	}
	out := make([]TopicBriefDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, TopicBriefDTO{ID: r.PublicID, Title: r.Title, Kind: r.Kind, Locked: r.Locked, Pinned: r.Pinned})
	}
	return out, nil
}

// ListUserTopics 是个人主页：按发帖时间倒序，作者看得见自己的 pending/rejected（§3.5 Q4a）。
func (s *Service) ListUserTopics(ctx context.Context, actor *authz.Actor, handle string, in PageInput) (*TopicPage, error) {
	user, err := s.repo.UserBriefByHandle(ctx, handle)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, apperr.New("user.not_found", 404, "用户不存在")
		}
		return nil, err
	}
	limit := limitOf(in.Limit)
	cursorT, cursorID, err := pageCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	uid := user.ID
	rows, err := s.repo.ListTopics(ctx, pgsql.TopicFilter{
		AuthorID: &uid, Sort: pgsql.SortNew,
		CursorT: cursorT, CursorID: cursorID, Limit: limit, ViewerID: viewerID(actor),
	}, false)
	if err != nil {
		return nil, err
	}
	items := make([]TopicCardDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, s.topicCard(r))
	}
	return &TopicPage{Items: items, NextCursor: nextCursor(rows, limit, topicCursorRef("created_at"))}, nil
}

// ListBookmarks 是收藏页：按**收藏时间**倒序（§3.6 Q5，需要登录）。
func (s *Service) ListBookmarks(ctx context.Context, actor *authz.Actor, in PageInput) (*TopicPage, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	cursorT, cursorID, err := pageCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.ListTopicsByBookmark(ctx, actor.UserID, cursorT, cursorID, limit)
	if err != nil {
		return nil, err
	}
	items := make([]TopicCardDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, s.topicCard(r))
	}
	// 收藏页的游标是 (bookmarks.created_at, topic_id)：与那条查询的 ORDER BY 逐字同源。
	return &TopicPage{Items: items, NextCursor: nextCursor(rows, limit, topicCursorRef("bookmarked_at"))}, nil
}

// topicCursorRef 是列表游标的取值：默认流用 last_reply_at，sort=new / 个人主页用 created_at，
// 收藏页用**收藏时间**。游标里的排序键必须与那条查询的 ORDER BY 逐字同源，否则翻页会跳行。
func topicCursorRef(col string) func(pgsql.TopicRow) (time.Time, int64) {
	return func(r pgsql.TopicRow) (time.Time, int64) {
		switch col {
		case "created_at":
			return r.CreatedAt, r.ID
		case "bookmarked_at":
			if r.BookmarkedAt != nil {
				return *r.BookmarkedAt, r.ID
			}
			return r.CreatedAt, r.ID
		default:
			return r.LastReplyAt, r.ID
		}
	}
}

// ---- 读：详情 ----

// TopicDetail 是详情：主题 + 1 楼正文 + 下载源 + 我的三态（§3.7 Q6/Q7a/Q7c）。
// 详情页每读一次加一次 counter（§8.2）：不加的话，用户刚看完的帖子浏览数不变。
func (s *Service) TopicDetail(ctx context.Context, actor *authz.Actor, publicID string) (*TopicDetailDTO, error) {
	row, err := s.repo.TopicDetail(ctx, publicID, viewerID(actor), canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrTopicNotFound
		}
		return nil, err
	}
	s.count.Add(counterTopicViewKey(row.ID), 1)
	sources, err := s.repo.Sources(ctx, row.ID)
	if err != nil {
		return nil, err
	}
	// 「最后过审版本」（拍板 08 · L6）：只有涉及打回时才需要它，所以**只在那一态查**
	// （打回修改是少数路径，别让每一次详情页读都多一条查询）。
	// 读不到快照是正常情况：一条从没被批准过的帖不会有过审版本（nil = 字段不出现在响应里）。
	var rev *pgsql.ApprovedRevisionRow
	if row.ReviewState == ReviewStateRevisionRequested {
		rev, err = s.repo.ApprovedRevision(ctx, row.ID)
		if err != nil {
			return nil, err
		}
	}
	d := s.topicDetailDTO(*row, sources, rev)
	return &d, nil
}

// ---- 写：发主题 ----

// CreateTopic 是发主题（§4.2 的完整事务边界）。
//
// 判定顺序照 §4.1：Require → 分区存在 → 发言权（禁言 → ACL → 等级）→ 事务内写。
// 事务内只做数据库读写 + EnqueueTx；搜索索引与通知任务与业务同事务。
func (s *Service) CreateTopic(ctx context.Context, actor *authz.Actor, in CreateTopicInput) (*TopicDetailDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermTopicCreate); err != nil {
		return nil, err
	}
	kind := in.Kind
	if kind == "" {
		kind = "discussion"
	}
	if _, err := parseKind(kind); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(in.Title)
	if title == "" || len([]rune(title)) > 200 {
		return nil, invalid("title", "标题不能为空，且不超过 200 字")
	}
	if in.BoardSlug == "" {
		return nil, invalid("board", "必须选择分区")
	}
	if len(in.ClientToken) > 64 {
		return nil, invalid("client_token", "长度不能超过 64")
	}
	if strings.TrimSpace(in.ContentMD) == "" {
		return nil, invalid("content_md", "正文不能为空")
	}
	if err := checkContentLen(in.ContentMD, MaxTopicContent, "content_md"); err != nil {
		return nil, err
	}
	boardID, status, err := s.repo.BoardIDBySlug(ctx, in.BoardSlug)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrBoardNotFound
		}
		return nil, err
	}
	if status != "active" {
		return nil, ErrBoardNotFound // 归档分区不能发新帖（§3.3 Q2e 的 status 过滤）
	}
	if err := s.canSpeak(ctx, actor, boardID, "post"); err != nil {
		return nil, err
	}
	html, plain, err := s.render(in.ContentMD)
	if err != nil {
		return nil, err
	}

	// 审核豁免（拍板 §2.2 第 1 条）：trusted 或持 post.review 的人直接发布。
	state := "approved"
	if !canReview(actor) {
		brief, err := s.repo.UserAuthBrief(ctx, actor.UserID)
		if err != nil {
			return nil, err
		}
		if !brief.Trusted {
			state = "pending"
		}
	}

	// 幂等键的常规路径：这个 token 已经发过一次了，直接返回那一条（连事务都不开）。
	if in.ClientToken != "" {
		if _, existing, err := s.repo.TopicIDByClientToken(ctx, actor.UserID, in.ClientToken); err == nil {
			return s.TopicDetail(ctx, actor, existing)
		} else if err != pgsql.ErrNoRows {
			return nil, err
		}
	}
	// 事务内只做数据库读写 + EnqueueTx（拍板 §5.4）；出参是那一行的 public_id。
	now := s.clk.Now().UTC()
	publicID := newPublicID()
	err = s.insertTopic(ctx, actor, boardID, kind, title, html, plain, state, in, now, &publicID)
	if err != nil {
		return nil, err
	}
	return s.TopicDetail(ctx, actor, publicID)
}

// insertTopic 是发主题的写事务。
//
// 幂等键撞车走**回滚后重来一次**这条路（§4.3）：PostgreSQL 里一条语句报错会把整个事务
// 置为 aborted，同一事务内再查也是 25P02——所以「插入失败后回查」只能在事务**之外**做。
// 先用 token 查一次是最便宜的那条路（返回到同一行、连事务都不开）；并发漏网的那一次
// 由唯一索引兜住，然后外层重跑一遍、这次先查到已有行。
func (s *Service) insertTopic(ctx context.Context, actor *authz.Actor, boardID int64, kind, title, html, plain, state string,
	in CreateTopicInput, now time.Time, publicID *string) error {
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		id, err := pgsql.InsertTopic(ctx, tx, *publicID, boardID, actor.UserID, kind, title,
			clipExcerpt(plain), state, nil, in.ClientToken, now)
		if err != nil {
			return err
		}
		if _, err := pgsql.InsertTopicBody(ctx, tx, newPublicID(), id, actor.UserID, in.ContentMD, html, now); err != nil {
			return err
		}
		if err := s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeSearchIndex, Payload: map[string]int64{"id": id}, UniqueKey: "topic:" + itoa64(id),
		}); err != nil {
			return err
		}
		// AI 审核（d7 §1/§6）：**与发帖同事务入队**，但 AI 调用绝不在这条事务里发生。
		// priority=20 高于验证码邮件(10)：用户可以晚几秒收到信，但帖子晚几秒审完他就在看「审核中」；
		// max_retry=2（d7 §6）：重试太久没意义，第 3 次直接交人工（主题留在 pending）。
		return s.enqueue(ctx, tx, queue.Task{
			Type:      queue.TypeAIReview,
			Payload:   map[string]any{"topic_id": id, "trigger": "create"},
			UniqueKey: "review:create:" + itoa64(id), Priority: 20, MaxRetry: 2,
		})
	})
	if err == nil || in.ClientToken == "" || !isUniqueViolation(err) {
		return err
	}
	// 撞车了：重跑一遍。这一次开头那次回查会命中（并发的对方已经提交）。
	_, existing, lookupErr := s.repo.TopicIDByClientToken(ctx, actor.UserID, in.ClientToken)
	if lookupErr != nil {
		return err // 回查不到说明撞的不是 token 那一条索引，把原始错误报上去
	}
	*publicID = existing
	return nil
}

// UpdateTopic 是 PATCH /topics/{id}（§4.5）：
// 标题 / 正文（1 楼）/ kind / 分区（要 topic.move）/ resource_status。
func (s *Service) UpdateTopic(ctx context.Context, actor *authz.Actor, publicID string, in UpdateTopicInput) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	if err := requirePerm(actor, authz.PermTopicEditOwn); err != nil {
		return err
	}
	ref, err := s.repo.TopicRef(ctx, publicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrTopicNotFound
		}
		return err
	}
	// 改不了就是「不存在」：查不到 / 不可见 / 已软删与「不是你的帖」给同一个 404。
	// 分开就等于承认这条主题存在（errors.go 的承诺），而这正是 403 会漏的东西。
	if err := s.requireTopicEdit(actor, ref); err != nil {
		return err
	}

	var title, kind *string
	var boardID *int64
	var resourceStatus *string
	clearResourceStatus := in.ResourceStatus != nil && *in.ResourceStatus == ""
	k := ref.Kind
	if kind != nil {
		k = *kind
	}
	if resourceStatus != nil && k != "resource" {
		return invalid("resource_status", "只有资源帖可以设置维护状态")
	}

	if in.Title != nil {
		t := strings.TrimSpace(*in.Title)
		if t == "" || len([]rune(t)) > 200 {
			return invalid("title", "标题不能为空，且不超过 200 字")
		}
		title = &t
	}
	if in.Kind != nil {
		k, err := parseKind(*in.Kind)
		if err != nil {
			return err
		}
		kind = &k
	}
	if in.BoardSlug != nil {
		id, status, err := s.repo.BoardIDBySlug(ctx, *in.BoardSlug)
		if err != nil {
			if err == pgsql.ErrNoRows {
				return ErrBoardNotFound
			}
			return err
		}
		if status != "active" {
			return ErrBoardNotFound
		}
		boardID = &id
	}
	if in.ResourceStatus != nil && !clearResourceStatus {
		switch *in.ResourceStatus {
		case "maintained", "bugfix_only", "unmaintained":
			resourceStatus = in.ResourceStatus
		default:
			return invalid("resource_status", "只能是 maintained / bugfix_only / unmaintained")
		}
	}

	var html, excerpt string
	if in.ContentMD != nil {
		if strings.TrimSpace(*in.ContentMD) == "" {
			return invalid("content_md", "正文不能为空")
		}
		if err := checkContentLen(*in.ContentMD, MaxTopicContent, "content_md"); err != nil {
			return err
		}
		h, plain, err := s.render(*in.ContentMD)
		if err != nil {
			return err
		}
		html, excerpt = h, clipExcerpt(plain)
	}

	now := s.clk.Now().UTC()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		if err := pgsql.UpdateTopicFields(ctx, tx, ref.ID, title, kind, boardID, resourceStatus, clearResourceStatus, now); err != nil {
			return err
		}
		// 移动分区只有持 topic.move 的人能做（拍板 §1.2）。
		if boardID != nil && !actor.IsSuper && !actor.Perms.Has(authz.PermTopicMove) {
			return apperr.ErrForbidden
		}
		if in.ContentMD != nil {
			postID, err := s.firstPostID(ctx, ref.ID)
			if err != nil {
				return err
			}
			if err := pgsql.UpdatePostContent(ctx, tx, postID, *in.ContentMD, html, now); err != nil {
				return err
			}
			if err := pgsql.SetTopicExcerpt(ctx, tx, ref.ID, excerpt, now); err != nil {
				return err
			}
			// **改过正文就回待审**（老站的流程）：作者改完要重新过一遍审核，AI 也重新看一次。
			// 只改标题/分区不算内容变更 —— 那是分类问题，不该让一篇正常帖子掉出可见状态。
			// 谁改都重置：管理端改正文同样是「内容变了」。
			if err := pgsql.ResetTopicReview(ctx, tx, ref.ID, now); err != nil {
				return err
			}
		}
		// resource → 非 resource：删掉它的下载源，否则留下挂错地方的源（§4.5）。
		if kind != nil && *kind != "resource" && ref.Kind == "resource" {
			if err := pgsql.DeleteSourcesOfTopic(ctx, tx, ref.ID); err != nil {
				return err
			}
		}
		return s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeSearchIndex, Payload: map[string]int64{"id": ref.ID}, UniqueKey: "topic:" + itoa64(ref.ID),
		})
	})
}

// DeleteTopic 是删主题（§4.6）：软删主题 + 全部楼层 + 该主题的票，并重投搜索索引删行。
func (s *Service) DeleteTopic(ctx context.Context, actor *authz.Actor, publicID string) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	if err := requirePerm(actor, authz.PermTopicDeleteOwn); err != nil {
		return err
	}
	ref, err := s.repo.TopicRef(ctx, publicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrTopicNotFound
		}
		return err
	}
	if !canEditTopic(actor, authz.PermTopicDeleteOwn, authz.PermTopicDeleteAny, ref.AuthorID, ref.BoardID) {
		return apperr.ErrForbidden
	}
	now := s.clk.Now().UTC()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		if err := pgsql.DeleteTopicRows(ctx, tx, ref.ID, now); err != nil {
			return err
		}
		// **必须投这个任务**：否则被删的帖子还能被搜到，「软删」承诺就失效了（§4.6 末段）。
		return s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeSearchIndex, Payload: map[string]int64{"id": ref.ID}, UniqueKey: "topic:" + itoa64(ref.ID),
		})
	})
}

// LockTopic 是锁定 / 解锁，幂等（§4.7）：重复锁不报错，也不刷新时间戳。
func (s *Service) LockTopic(ctx context.Context, actor *authz.Actor, publicID string, locked bool) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	if err := requirePerm(actor, authz.PermTopicLock); err != nil {
		return err
	}
	ref, err := s.repo.TopicRef(ctx, publicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrTopicNotFound
		}
		return err
	}
	if !canLockTopic(actor, ref.AuthorID, ref.BoardID) {
		return apperr.ErrForbidden
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		_, err := pgsql.LockTopic(ctx, tx, ref.ID, locked, s.clk.Now().UTC())
		return err
	})
}

// PinTopic 是置顶与精华（§4.7）。两者共用 topic.pin（拍板 §10.9 定案）。
// field 只接受 "pin" | "feature"：**一次只改一列**，另一个保持不变——
// 否则点「置顶」会把精华一起取消掉，而那是用户没做的事。
func (s *Service) PinTopic(ctx context.Context, actor *authz.Actor, publicID, field string, on bool) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	if err := requirePerm(actor, authz.PermTopicPin); err != nil {
		return err
	}
	var column string
	switch field {
	case "pin":
		column = "pinned_at"
	case "feature":
		column = "featured_at"
	default:
		return invalid("field", "只能是 pin / feature")
	}
	ref, err := s.repo.TopicRef(ctx, publicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrTopicNotFound
		}
		return err
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		// 转载帖不能置顶：UPDATE 的 WHERE 带 kind <> 'repost'，0 行就是拒绝。
		changed, err := pgsql.PinTopic(ctx, tx, ref.ID, column, on, s.clk.Now().UTC())
		if err != nil {
			return err
		}
		if !changed && ref.Kind == "repost" {
			return apperr.ErrForbidden
		}
		return nil
	})
}

// requireTopicEdit 是「改这条主题」的权限：作者走 own，其他人走 delete.any（管理端）或版主作用域。
// 拍板 §1.2 没有单独的 topic.edit.any——改别人的帖子由 delete.any + board.moderate 表达。
//
// 判不下来时给 ErrTopicNotFound 而不是 ErrForbidden（**故意的**）：这个函数的调用者都已经
// 过了中间件的 topic.edit.own，也就是「能改自己的帖」，所以拒绝只可能发生在别人的帖上 ——
// 403 等于告诉一个普通用户「这条主题存在，只是不归你」。errors.go 承诺过
// 「不存在 / 不可见 / 已软删不区分」，这一条就是那句话的落点（D4，2026-10-14）。
// 能看见这条主题的人（版主 / 持 delete.any 的管理员）走的是上面那个分支，不受影响。
func (s *Service) requireTopicEdit(actor *authz.Actor, ref *pgsql.TopicRef) error {
	if canEditTopic(actor, authz.PermTopicEditOwn, authz.PermTopicDeleteAny, ref.AuthorID, ref.BoardID) {
		return nil
	}
	return ErrTopicNotFound
}

func parseTopicSort(s string) (pgsql.TopicSort, error) {
	switch s {
	case "", "latest":
		return pgsql.SortLatest, nil
	case "new":
		return pgsql.SortNew, nil
	case "hot":
		// 最热（拍板 08 · L2）：口径写在 pgsql.hotScoreSQL 上，只有那一处。
		return pgsql.SortHot, nil
	default:
		return "", invalid("sort", "只能是 latest / new / hot")
	}
}

func parseKind(k string) (string, error) {
	switch k {
	case "discussion", "resource", "repost":
		return k, nil
	default:
		return "", invalid("kind", "只能是 discussion / resource / repost")
	}
}

func newPublicID() string {
	id, err := idgen.NewPublicID()
	if err != nil {
		// crypto/rand 不可用说明进程已经不正常；这里 panic 会被 Recover 变成 500，
		// 但比「生成一个空 uuid 写进库」好——那会污染数据。
		panic(err)
	}
	return id.String()
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
