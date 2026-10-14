package forum

import (
	"forum/internal/forum/pgsql"
)

// 行 → DTO 的全部转换都在这里。service 只做判定与编排，映射不掺业务。

func userBriefDTO(u pgsql.UserRow) UserBriefDTO {
	d := UserBriefDTO{
		Handle: u.Handle, Nickname: u.Nickname,
		AvatarHash: deref(u.AvatarHash), AvatarSmall: deref(u.AvatarSmall),
	}
	// 角色只有**查得到的那几条路径**填（目前是主题详情；见 dto.go 的 Role 注释）：
	// 没查的行 RoleKey 是 nil，这里就不给 role 这个键（而不是给一个空对象）。
	if u.RoleKey != nil && u.RoleName != nil {
		d.Role = &RoleRefDTO{Key: *u.RoleKey, Name: *u.RoleName, BadgeColor: u.RoleBadgeColor}
	}
	return d
}

func (s *Service) topicCard(r pgsql.TopicRow) TopicCardDTO {
	d := TopicCardDTO{
		ID: r.PublicID, Kind: r.Kind, Title: r.Title, Excerpt: r.Excerpt,
		Board:      BoardRefDTO{Slug: r.BoardSlug, Name: r.BoardName},
		Author:     userBriefDTO(r.Author),
		ReplyCount: r.ReplyCount, LikeCount: r.LikeCount,
		// 详情页每次读都 +1 进缓冲，所以列表也要把它加回来，否则两个页面上的数字对不上（§8.2）。
		ViewCount:   r.ViewCount + s.count.Get(counterTopicViewKey(r.ID)),
		LastReplyAt: r.LastReplyAt.UTC(), CreatedAt: r.CreatedAt.UTC(),
		Pinned: r.Pinned, Featured: r.Featured, Locked: r.Locked,
		CoverHash: deref(r.CoverHash), CoverWidth: r.CoverWidth, CoverHeight: r.CoverHeight,
	}
	if r.BookmarkedAt != nil {
		t := r.BookmarkedAt.UTC()
		d.BookmarkedAt = &t
	}
	// 个人主页与收藏页要显示自己的帖子在哪一态；公开列表给了也无害（它们恒是 normal/approved）。
	d.Visibility = r.Visibility
	d.ReviewState = r.ReviewState
	return d
}

// topicDetailDTO 把详情行拼成响应。**「谁在什么时候看到哪一版」全部在这一处**
// （拍板 08 第二轮 · 6.2：编辑不动原帖、通过再替换）：
//
//	rev   最后过审版本（topic_revisions.content_md），也就是线上那一份。nil = 从没过审。
//	draft 作者手上还没过审的那一版（pending_md）。nil = 没有待审改动。
//
// 三种读者 × 三个版本：
//
//	读者（游客 / 别人） 永远拿到 posts 的正文 = 线上那一版。它只在**放行**那一刻变，
//	                    所以「读者看不到未过审的改动」不是前端藏，是后端根本不下发。
//	作者本人            有待审改动时拿到 draft（content_md），revision_of 给出线上那一版
//	                    当参照；没有改动时两边逐字相同。
//	审核员（canSeePending） 与作者同支：他要判的就是这份改动（队列里只能看到摘要）。
//	                    队列本身走另一条 DTO（ReviewQueueItemDTO + review_note），不经过这里。
func (s *Service) topicDetailDTO(r pgsql.TopicDetailRow, sources []pgsql.SourceRow,
	viewer int64, canSeePending bool, rev *pgsql.ApprovedRevisionRow, draft *string) TopicDetailDTO {
	d := TopicDetailDTO{
		ID: r.PublicID, Kind: r.Kind, Title: r.Title, Excerpt: r.Excerpt,
		Board:  BoardRefDTO{Slug: r.BoardSlug, Name: r.BoardName},
		Author: userBriefDTO(r.Author),
		// 1 楼被软删时正文换成空串：标题还在，这就是「正文删了标题还在」。
		ContentMD:      r.ContentMD,
		ContentHTML:    r.ContentHTML,
		ContentDeleted: r.ContentDeleted,
		ResourceStatus: r.ResourceStatus,
		ReplyCount:     r.ReplyCount,
		LikeCount:      r.LikeCount,
		ViewCount:      r.ViewCount + s.count.Get(counterTopicViewKey(r.ID)),
		IssueOpenCount: r.IssueOpenCount,
		Pinned:         r.Pinned, Featured: r.Featured, Locked: r.Locked,
		// 封面宽高与列表卡片同一个来源（拍板 08 · J9）：详情页的图集也要按真实宽高开容器。
		CoverHash: deref(r.CoverHash), CoverWidth: r.CoverWidth, CoverHeight: r.CoverHeight,
		// UpdatedAt 以前**从没赋值**（dto.go 声明了它）—— 于是接口永远返回 Go 零值 `0001-01-01T00:00:00Z`，
		// 而库里其实更新了：盲测 PATCH 主题后标题与正文真的变了、DB 里 updated_at 也变了，只有响应是零值。
		CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(), LastReplyAt: r.LastReplyAt.UTC(),
		ReviewState: r.ReviewState,
		Viewer:      ViewerDTO{Liked: r.MyVote == 1, Bookmarked: r.Bookmarked},
		Sources:     sourceDTOs(sources),
	}
	const deletedHTML = "<p>正文已被作者删除</p>"
	if d.ContentDeleted {
		d.ContentMD, d.ContentHTML = "", deletedHTML
	}
	// 作者看到自己手上那一版：**只换正文，不换 RevisionOf** ——
	// 「最后一个过审版本」这句话在有待审改动时才成立（没有它，revision_of 会与 content_md 重复）。
	//
	// **只有作者**吃这一支（判据是归属，不是权限点）：读者拿到的是 posts 里那一份，
	// 也就是最后一个过审版本 —— 这是 06.2 的全部要点，漏了这句注释下的那行 if，
	// 未过审的改动就对所有人可见了。
	if draft != nil && (r.Author.ID == viewer || canSeePending) {
		d.ContentMD = *draft
		d.PendingDraft = true
	}
	if rev != nil && rev.HasPending {
		// 有草稿时才给参照物：这一版是拿 posts 里那一份快照出来的，也就是读者正在看的那一份。
		d.RevisionOf = &TopicRevisionDTO{
			ContentMD: rev.ContentMD, ContentHTML: rev.ContentHTML, ApprovedAt: rev.ApprovedAt.UTC(),
		}
	}
	// review_note 只给作者看（拍板 §6）：别人连主题都看不到，所以这里只多一层保险。
	d.ReviewNote = r.ReviewNote
	return d
}

func sourceDTOs(rows []pgsql.SourceRow) []SourceDTO {
	out := make([]SourceDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, sourceDTO(r))
	}
	return out
}

func sourceDTO(r pgsql.SourceRow) SourceDTO {
	d := SourceDTO{
		ID: r.PublicID, Label: r.Label, URL: r.URL, Provider: r.Provider,
		ExtractionCode: r.ExtractionCode, Size: r.SizeText, Upkeep: r.Upkeep,
		GoPath: "/api/v1/topics/" + r.TopicPublicID + "/sources/" + r.PublicID + "/go",
	}
	if r.VerifiedAt != nil {
		t := r.VerifiedAt.UTC()
		d.VerifiedAt = &t
	}
	return d
}

func (s *Service) issueDTO(r pgsql.IssueRow) IssueDTO {
	d := IssueDTO{
		ID: r.PublicID, Number: r.Number, Kind: r.Kind, Title: r.Title,
		Status: issueStatusAPI(r.Status),
		Author: userBriefDTO(r.Author),
		Tags:   r.Tags, CommentCount: r.CommentCount,
		CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
		TopicID: itoa64(r.TopicID), TopicTitle: r.TopicTitle,
		Board: BoardRefDTO{Slug: r.BoardSlug, Name: r.BoardName},
	}
	if d.Tags == nil {
		d.Tags = []string{}
	}
	if r.ClosedAt != nil {
		t := r.ClosedAt.UTC()
		d.ClosedAt = &t
	}
	if r.Assignee != nil {
		a := userBriefDTO(*r.Assignee)
		d.Assignee = &a
	}
	return d
}

// issueStatusAPI 是 status 的换算（§7.7）：数据库 keep_open|closed → API open|closed。
// **只此一处**，别的任何地方都不许再写一遍这个 switch。
func issueStatusAPI(db string) string {
	if db == "closed" {
		return "closed"
	}
	return "open"
}

// issueStatusDB 是上一条的反向。?status 传别的值 → 400（不静默当「不过滤」）。
func issueStatusDB(api string) (string, error) {
	switch api {
	case "":
		return "", nil
	case "open":
		return "keep_open", nil
	case "closed":
		return "closed", nil
	default:
		return "", invalid("status", "只能是 open / closed")
	}
}

func issueCommentDTO(r pgsql.IssueCommentRow) IssueCommentDTO {
	return IssueCommentDTO{
		ID: r.PublicID, ParentID: r.ParentPublicID, BodyHTML: r.BodyHTML,
		Author: userBriefDTO(r.Author), LikeCount: r.LikeCount, DislikeCount: r.DislikeCount,
		MyVote: r.MyVote, CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
	}
}

// hideCommentDislike 与 hideDislike 同一条规矩（Issue 评论的 DTO 是另一个类型，
// 而把它与 PostDTO 合并成泛型只会让两个字段名绑在一起 —— 它们的父字段就不一样）。
func hideCommentDislike(d *IssueCommentDTO, show bool) {
	if !show {
		d.DislikeCount = 0
	}
}
