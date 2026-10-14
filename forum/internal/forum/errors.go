package forum

import (
	"errors"
	"net/http"

	"forum/internal/platform/apperr"
)

// errNoRenderer 是配置缺失：没有 Markdown 渲染器时**不静默降级**——
// 把用户输入的 markdown 当 HTML 发出去就是 XSS，宁可 500。
var errNoRenderer = errors.New("forum: 未配置 Markdown 渲染器（deps.Render）")

// 本域的错误码（d3-forum §10）。**只在这里定义**：handler 不许自己造码。
//
// topic.not_found / post.not_found / issue.not_found 各自一条覆盖「不存在 / 不可见 / 已软删」，
// 不区分——区分就等于承认它存在（§10 末段）。日志里用 reason 字段区分，响应里不分。
var (
	ErrTopicNotFound  = apperr.New("topic.not_found", http.StatusNotFound, "主题不存在或已被删除")
	ErrPostNotFound   = apperr.New("post.not_found", http.StatusNotFound, "楼层不存在")
	ErrIssueNotFound  = apperr.New("issue.not_found", http.StatusNotFound, "反馈不存在")
	ErrSourceNotFound = apperr.New("source.not_found", http.StatusNotFound, "下载源不存在")
	ErrBoardNotFound  = apperr.New("board.not_found", http.StatusNotFound, "分区不存在")
	// 版主任免的两条（C2）。与 board.not_found 分开：前端要把「这个人不是版主」与
	// 「这个分区不存在」显示成两句不同的话 —— 免一个本来就不是版主的人时，管理员多半点错了行。
	ErrAdminModeratorNotFound     = apperr.New("board.moderator_not_found", http.StatusNotFound, "这个人不是该分区的版主")
	ErrAdminModeratorUserNotFound = apperr.New("board.moderator_user_not_found", http.StatusNotFound, "用户不存在")

	ErrTopicLocked   = apperr.New("topic.locked", http.StatusForbidden, "主题已锁定，不能再回复")
	ErrReviewPending = apperr.New("topic.review_pending", http.StatusForbidden, "主题正在审核中，通过后才能回复")
	ErrSanctioned    = apperr.New("forum.sanctioned", http.StatusForbidden, "你被禁止在此发言")
	ErrLevelTooLow   = apperr.New("forum.level_too_low", http.StatusForbidden, "等级不足，暂时不能在此发帖")
	ErrBlocked       = apperr.New("forum.blocked", http.StatusForbidden, "无法回复该用户的内容")
	ErrACLDenied     = apperr.New("board.acl_denied", http.StatusForbidden, "你没有在此分区发言的权限")

	ErrNotResource    = apperr.New("forum.not_resource", http.StatusBadRequest, "只有资源帖可以挂下载源或提反馈")
	ErrParentNested   = apperr.New("forum.reply_parent_nested", http.StatusBadRequest, "只允许回复一级评论")
	ErrParentTopic    = apperr.New("forum.reply_parent_cross_topic", http.StatusBadRequest, "回复的评论不属于该主题")
	ErrVoteValue      = apperr.New("forum.vote_value_invalid", http.StatusBadRequest, "投票值只能是赞或踩")
	ErrSortUnpageable = apperr.New("forum.page_sort_unpageable", http.StatusBadRequest, "该排序不支持翻页")
)

// invalid 是参数校验失败的唯一出口（带 fields，前端按 JSON 字段名挂错误）。
func invalid(field, msg string) *apperr.Error {
	return apperr.Invalid(map[string]string{field: msg})
}
