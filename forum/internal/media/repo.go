package media

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// 本文件是本模块的**全部原生 SQL**。哈希是内容寻址的自然键、topic_images 的主键是
// (topic_id, post_id, image_hash)，这两处 ent 表达不了（见 internal/ent/schema/image.go 的文件头）。
//
// 全部读单行的查询都走 row1：ent 的 Tx 只有 QueryContext，没有 QueryRowContext。

// row1 取一行。没有行时返回 sql.ErrNoRows。
func row1(ctx context.Context, q sqlExec, query string, args []any, dest ...any) error {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return sql.ErrNoRows
	}
	return rows.Scan(dest...)
}

// imageRow 是一行 images 的判定与分发需要的列。
type imageRow struct {
	Hash       string
	Size       int64
	Mime       string
	Width      int
	Height     int
	Visibility int
	OwnerID    *int64
}

// incRefTx 是 images 的 upsert（d5 §2.3-A）：同 hash 再上传就 +1，不去重成一行。
func incRefTx(ctx context.Context, q sqlExec, hash string, size int64, mime string, w, h int, visibility int, ownerID *int64) error {
	_, err := q.ExecContext(ctx, `
INSERT INTO images (hash, size, mime, width, height, refcount, visibility, owner_id, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, 1, $6, $7, now(), now())
ON CONFLICT (hash) DO UPDATE
   SET refcount = images.refcount + 1, updated_at = now()`,
		hash, size, mime, w, h, visibility, ownerID)
	if err != nil {
		return fmt.Errorf("media: upsert image %s: %w", hash, err)
	}
	return nil
}

// decRefTx 是解引用（d5 §2.3-B）。refcount 减到 0 是正常结果，不是错误。
func decRefTx(ctx context.Context, q sqlExec, hash string) error {
	_, err := q.ExecContext(ctx, `
UPDATE images SET refcount = refcount - 1, updated_at = now()
 WHERE hash = $1 AND refcount > 0`, hash)
	if err != nil {
		return fmt.Errorf("media: deref image %s: %w", hash, err)
	}
	return nil
}

// imageMeta 读一行 images 用于可见性判定与分发。返回 nil 表示没有这行。
func imageMeta(ctx context.Context, q sqlExec, hash string) (*imageRow, error) {
	var r imageRow
	err := row1(ctx, q, `
SELECT hash, size, mime, width, height, visibility, owner_id
  FROM images WHERE hash = $1`, []any{hash},
		&r.Hash, &r.Size, &r.Mime, &r.Width, &r.Height, &r.Visibility, &r.OwnerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("media: read image %s: %w", hash, err)
	}
	return &r, nil
}

// lockTopic 锁主题行并返回作者与可见性（d5 §3.2：数量闸门靠行锁串行化）。
// 返回 id==0 表示没有这个主题。
func lockTopic(ctx context.Context, q sqlExec, publicID string) (id, authorID int64, visibility string, err error) {
	err = row1(ctx, q, `
SELECT id, author_id, visibility FROM topics WHERE public_id = $1 FOR UPDATE`, []any{publicID},
		&id, &authorID, &visibility)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, "", nil
	}
	if err != nil {
		return 0, 0, "", fmt.Errorf("media: lock topic %s: %w", publicID, err)
	}
	return id, authorID, visibility, nil
}

// firstPost 取 1 楼：配图挂在楼层上（topic_images 的键含 post_id）。0 = 还没有楼层。
func firstPost(ctx context.Context, q sqlExec, topicID int64) (int64, error) {
	var id int64
	err := row1(ctx, q, `
SELECT id FROM posts WHERE topic_id = $1 AND floor = 1`, []any{topicID}, &id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("media: read first post of topic %d: %w", topicID, err)
	}
	return id, nil
}

// countTopicImages 数这一帖已有的配图（每帖 ≤9，d5 §3.2）。
func countTopicImages(ctx context.Context, q sqlExec, topicID int64) (int, error) {
	var n int
	if err := row1(ctx, q, "SELECT count(*) FROM topic_images WHERE topic_id = $1", []any{topicID}, &n); err != nil {
		return 0, fmt.Errorf("media: count topic images: %w", err)
	}
	return n, nil
}

// nextSort 取这张帖子里的下一个位置（0..8；uq_topic_images_sort 保证不会撞）。
func nextSort(ctx context.Context, q sqlExec, topicID, postID int64) (int, error) {
	var n int
	err := row1(ctx, q, `
SELECT COALESCE(MAX(sort) + 1, 0) FROM topic_images WHERE topic_id = $1 AND post_id = $2`,
		[]any{topicID, postID}, &n)
	if err != nil {
		return 0, fmt.Errorf("media: next sort: %w", err)
	}
	return n, nil
}

// insertTopicImage 幂等：同帖同图再传一次不报错（PK 冲突就跳过）。
func insertTopicImage(ctx context.Context, q sqlExec, topicID, postID int64, hash string, sort int) error {
	_, err := q.ExecContext(ctx, `
INSERT INTO topic_images (topic_id, post_id, image_hash, sort, created_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (topic_id, post_id, image_hash) DO NOTHING`,
		topicID, postID, hash, sort)
	if err != nil {
		return fmt.Errorf("media: insert topic image: %w", err)
	}
	return nil
}

// deleteTopicImage 用 RETURNING 判「这张图本来在这个帖子里」：false = 404。
func deleteTopicImage(ctx context.Context, q sqlExec, topicID int64, hash string) (bool, error) {
	var got string
	err := row1(ctx, q, `
DELETE FROM topic_images WHERE topic_id = $1 AND image_hash = $2
RETURNING image_hash`, []any{topicID, hash}, &got)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("media: delete topic image: %w", err)
	}
	return true, nil
}

// lockUser 锁用户行（收款码数量闸门，d5 §3.2）。
func lockUser(ctx context.Context, q sqlExec, userID int64) error {
	var id int64
	if err := row1(ctx, q, "SELECT id FROM users WHERE id = $1 FOR UPDATE", []any{userID}, &id); err != nil {
		return fmt.Errorf("media: lock user %d: %w", userID, err)
	}
	return nil
}

func countChannels(ctx context.Context, q sqlExec, userID int64) (int, error) {
	var n int
	if err := row1(ctx, q, "SELECT count(*) FROM payment_channels WHERE user_id = $1", []any{userID}, &n); err != nil {
		return 0, fmt.Errorf("media: count channels: %w", err)
	}
	return n, nil
}

func insertChannel(ctx context.Context, q sqlExec, userID int64, publicID, label, hash string) (int64, error) {
	var id int64
	err := row1(ctx, q, `
INSERT INTO payment_channels (public_id, user_id, label, image_hash, sort, created_at)
VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort) + 1 FROM payment_channels WHERE user_id = $2), 0), now())
RETURNING id`, []any{publicID, userID, label, hash}, &id)
	if err != nil {
		return 0, fmt.Errorf("media: insert channel: %w", err)
	}
	return id, nil
}

// deleteChannel 归属判定在 WHERE 里（d5 §3.2）：空串 = 没有这行。
func deleteChannel(ctx context.Context, q sqlExec, userID int64, publicID string) (string, error) {
	var hash string
	err := row1(ctx, q, `
DELETE FROM payment_channels WHERE public_id = $1 AND user_id = $2
RETURNING image_hash`, []any{publicID, userID}, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("media: delete channel: %w", err)
	}
	return hash, nil
}

// readAvatarTx 读旧 hash 并锁住用户行：头像替换要先知道旧值才能 −1。
// 不用 UPDATE ... RETURNING 的子查询——它读到的是新值，不是 OLD。
func readAvatarTx(ctx context.Context, q sqlExec, userID int64) (string, error) {
	var old *string
	err := row1(ctx, q, "SELECT avatar_hash FROM users WHERE id = $1 FOR UPDATE", []any{userID}, &old)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("media: read avatar: %w", err)
	}
	return deref(old), nil
}

// setAvatarTx 写头像列（旧的 −1 由调用方在同一事务里先做）。
func setAvatarTx(ctx context.Context, q sqlExec, userID int64, hash string) error {
	_, err := q.ExecContext(ctx, `
UPDATE users SET avatar_hash = $2, avatar_small_hash = NULL, updated_at = now()
 WHERE id = $1`, userID, hash)
	if err != nil {
		return fmt.Errorf("media: set avatar: %w", err)
	}
	return nil
}

// clearAvatarTx 清掉头像两列。
func clearAvatarTx(ctx context.Context, q sqlExec, userID int64) error {
	_, err := q.ExecContext(ctx, `
UPDATE users SET avatar_hash = NULL, avatar_small_hash = NULL, updated_at = now()
 WHERE id = $1`, userID)
	if err != nil {
		return fmt.Errorf("media: clear avatar: %w", err)
	}
	return nil
}

// gcCandidates 是 image:gc 的第一半（d5 §2.3-C①）：归零满一小时、且不在默认头像池里。
func gcCandidates(ctx context.Context, q sqlExec, limit int) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
SELECT i.hash FROM images i
 WHERE i.refcount = 0
   AND i.updated_at < now() - interval '1 hour'
   AND NOT EXISTS (SELECT 1 FROM default_avatars d WHERE d.hash = i.hash)
 ORDER BY i.updated_at
 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("media: gc scan: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return nil, fmt.Errorf("media: gc scan row: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// deleteImageRow 只在盘上文件删掉（或本来就没有）之后调用。
func deleteImageRow(ctx context.Context, q sqlExec, hash string) error {
	_, err := q.ExecContext(ctx, "DELETE FROM images WHERE hash = $1 AND refcount = 0", hash)
	if err != nil {
		return fmt.Errorf("media: delete image row %s: %w", hash, err)
	}
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
