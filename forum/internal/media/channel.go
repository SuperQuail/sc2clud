package media

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// 收款码渠道的读路径。图的可见性是 public（L1，拍板第二轮：收款码是给人扫的，游客也要扫得到），
// 所以这里给的 URL 对谁都直出 —— 要不要把渠道列表对外展示是 reward 域 show_channels 开关的事。

// channelPublicID 取刚插入那行的 public_id 与 sort。
// payment_channels 的 public_id 由应用生成（DB 无默认值），所以插入时就带上。
func channelPublicID(ctx context.Context, q sqlExec, id int64) (string, int, error) {
	var publicID string
	var sort int
	err := row1(ctx, q, "SELECT public_id, sort FROM payment_channels WHERE id = $1", []any{id}, &publicID, &sort)
	if err != nil {
		return "", 0, fmt.Errorf("media: read channel: %w", err)
	}
	return publicID, sort, nil
}

func listChannels(ctx context.Context, q sqlExec, userID int64) ([]PaymentChannel, error) {
	rows, err := q.QueryContext(ctx, `
SELECT public_id, label, image_hash, sort
  FROM payment_channels WHERE user_id = $1 ORDER BY sort, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("media: list channels: %w", err)
	}
	defer rows.Close()
	out := make([]PaymentChannel, 0, 4)
	for rows.Next() {
		var c PaymentChannel
		var hash string
		if err := rows.Scan(&c.ID, &c.Label, &hash, &c.Sort); err != nil {
			return nil, fmt.Errorf("media: scan channel: %w", err)
		}
		c.Image = urlOf(hash)
		out = append(out, c)
	}
	return out, rows.Err()
}

// userIDByPublicID 返回 0 表示没有这个用户。
func userIDByPublicID(ctx context.Context, q sqlExec, publicID string) (int64, error) {
	id, err := uuid.Parse(publicID)
	if err != nil {
		return 0, ErrNotFound
	}
	var userID int64
	err = row1(ctx, q, "SELECT id FROM users WHERE public_id = $1", []any{id}, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("media: find user %s: %w", publicID, err)
	}
	return userID, nil
}
