package pgsql

import (
	"context"
	"database/sql"
	"errors"
)

// NoticeSettingRow 是 user_notice_settings 的一行（d4 §2.2 的四项）。
type NoticeSettingRow struct {
	Alert        bool
	ReplyScope   string
	MentionScope string
	LikeAlert    bool
}

// defaultNoticeSetting 是「还没有这一行」时的值，与 0018 的列默认值逐字一致。
func defaultNoticeSetting() NoticeSettingRow {
	return NoticeSettingRow{Alert: true, ReplyScope: "all", MentionScope: "all", LikeAlert: true}
}

// NoticeSetting 读一个人的消息设置；表里没有这一行返回列默认值（**不是**错误）：
// 一行一人，用户在设置页保存之前本来就没有行。
func (q *Queries) NoticeSetting(ctx context.Context, userID int64) (NoticeSettingRow, error) {
	r := defaultNoticeSetting()
	err := q.scanOne(ctx, []any{&r.Alert, &r.ReplyScope, &r.MentionScope, &r.LikeAlert}, `
SELECT alert, reply_scope, mention_scope, like_alert
  FROM user_notice_settings WHERE user_id = $1`, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultNoticeSetting(), nil
	}
	if err != nil {
		return r, err
	}
	return r, nil
}
