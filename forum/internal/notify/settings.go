package notify

import (
	"context"

	"forum/internal/notify/pgsql"
)

// NewNoticeSettings 用 user_notice_settings 实现本域的 NoticeSettings（deps.go 里那张表
// 就是为它建的）。deps.go 原本写「实现方 *user.Service」，但 users 域没有这张表，
// 所以实现放回本域：SQL 落 pgsql 包，app 层把它接进 NewService。
func NewNoticeSettings(pg *pgsql.Queries) NoticeSettings { return noticeSettings{pg: pg} }

type noticeSettings struct{ pg *pgsql.Queries }

func (n noticeSettings) Get(ctx context.Context, userID int64) (*NoticeSetting, error) {
	r, err := n.pg.NoticeSetting(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &NoticeSetting{
		Alert: r.Alert, ReplyScope: r.ReplyScope,
		MentionScope: r.MentionScope, LikeAlert: r.LikeAlert,
	}, nil
}
