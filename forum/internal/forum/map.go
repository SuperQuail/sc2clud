package forum

import (
	"forum/internal/forum/pgsql"
)

// 行 → DTO 的全部转换都在这里。service 只做判定与编排，映射不掺业务。

func userBriefDTO(u pgsql.UserRow) UserBriefDTO {
	return UserBriefDTO{
		Handle: u.Handle, Nickname: u.Nickname,
		AvatarHash: deref(u.AvatarHash), AvatarSmall: deref(u.AvatarSmall),
	}
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

func (s *Service) topicDetailDTO(r pgsql.TopicDetailRow, sources []pgsql.SourceRow) TopicDetailDTO {
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
		CreatedAt: r.CreatedAt.UTC(), LastReplyAt: r.LastReplyAt.UTC(),
		ReviewState: r.ReviewState,
		Viewer:      ViewerDTO{Liked: r.MyVote == 1, Bookmarked: r.Bookmarked},
		Sources:     sourceDTOs(sources),
	}
	const deletedHTML = "<p>正文已被作者删除</p>"
	if d.ContentDeleted {
		d.ContentMD, d.ContentHTML = "", deletedHTML
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
		ID: r.PublicID, ParentID: deref(r.ParentPublicID), BodyHTML: r.BodyHTML,
		Author: userBriefDTO(r.Author), LikeCount: r.LikeCount, DislikeCount: r.DislikeCount,
		MyVote: r.MyVote, CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
	}
}
