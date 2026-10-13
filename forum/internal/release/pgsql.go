package release

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// 本文件是本模块的**全部原生 SQL**。
// releases.published_at 与 status 的不变量（ck_releases_published_at：非 published 必须为 NULL）
// 让「改状态」与「设 published_at」必须一起算，ent 的 nil 守卫表达不了，所以 SQL 手写。

// row1 取一行；没有行返回 sql.ErrNoRows。ent 的 Tx 只有 QueryContext。
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

const selectColumns = `
SELECT id, public_id, version, channel, notes_md, notes_html, status, published_at, created_at
  FROM releases`

func scanRelease(dest *ReleaseDetail) []any {
	return []any{&dest.ID, &dest.Version, &dest.Channel, &dest.NotesMD, &dest.NotesHTML,
		&dest.Status, &dest.PublishedAt, &dest.CreatedAt}
}

// latestRelease 取最新发布的 stable（d5 §5.3）：吃 idx_releases_latest 的前三列等值 + 第四列有序。
func latestRelease(ctx context.Context, q sqlExec, channel string) (*ReleaseDetail, error) {
	var r ReleaseDetail
	var id int64
	var publicID uuid.UUID
	err := row1(ctx, q, selectColumns+`
 WHERE status = 'published' AND channel = $1
 ORDER BY published_at DESC, id DESC
 LIMIT 1`, []any{channel},
		&id, &publicID, &r.Version, &r.Channel, &r.NotesMD, &r.NotesHTML,
		&r.Status, &r.PublishedAt, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("release: latest %s: %w", channel, err)
	}
	r.ID = publicID.String()
	r.rowID = id
	return &r, nil
}

// listReleases 是历史版本的分页查询：排序键恒为 (published_at DESC, id DESC)，
// 游标就是它的行序比较（拍板 §5.1）。published 的行 published_at 一定非 NULL（状态机保证）。
func listReleases(ctx context.Context, q sqlExec, in ListReleasesInput, after time.Time, afterID int64) ([]ReleaseDetail, error) {
	rows, err := q.QueryContext(ctx, `
SELECT id, public_id, version, channel, notes_md, notes_html, status, published_at, created_at
  FROM releases
 WHERE status = 'published'
   AND ($1::text IS NULL OR channel = $1)
   AND (published_at, id) < ($2::timestamptz, $3::bigint)
 ORDER BY published_at DESC, id DESC
 LIMIT $4`, nullIfEmpty(in.Channel), after, afterID, in.Limit)
	if err != nil {
		return nil, fmt.Errorf("release: list: %w", err)
	}
	defer rows.Close()
	out := make([]ReleaseDetail, 0, in.Limit)
	for rows.Next() {
		var r ReleaseDetail
		var id int64
		var publicID uuid.UUID
		if err := rows.Scan(&id, &publicID, &r.Version, &r.Channel, &r.NotesMD, &r.NotesHTML,
			&r.Status, &r.PublishedAt, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("release: scan: %w", err)
		}
		r.ID = publicID.String()
		r.rowID = id
		r.Assets = []Asset{}
		out = append(out, r)
	}
	return out, rows.Err()
}

// assetsOf 一次取多个版本的全部产物（20 个版本 = 1 次往返，d5 §5.3）。
func assetsOf(ctx context.Context, q sqlExec, releaseIDs []int64) (map[int64][]Asset, error) {
	out := map[int64][]Asset{}
	if len(releaseIDs) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `
SELECT release_id, public_id, platform, arch, url, size, sha256, download_count
  FROM release_assets WHERE release_id = ANY($1::bigint[]) ORDER BY platform, arch`, releaseIDs)
	if err != nil {
		return nil, fmt.Errorf("release: assets: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var releaseID int64
		var a Asset
		var publicID uuid.UUID
		if err := rows.Scan(&releaseID, &publicID, &a.Platform, &a.Arch, &a.URL, &a.Size, &a.SHA256, &a.DownloadCount); err != nil {
			return nil, fmt.Errorf("release: scan asset: %w", err)
		}
		a.ID = publicID.String()
		out[releaseID] = append(out[releaseID], a)
	}
	return out, rows.Err()
}

// releaseIDByPublicID 返回 0 表示没有这个版本。
func releaseIDByPublicID(ctx context.Context, q sqlExec, publicID string) (int64, error) {
	id, err := uuid.Parse(publicID)
	if err != nil {
		return 0, nil
	}
	var releaseID int64
	err = row1(ctx, q, "SELECT id FROM releases WHERE public_id = $1", []any{id}, &releaseID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("release: find release: %w", err)
	}
	return releaseID, nil
}

// upsertRelease 写一行版本（d5 §5.4）。publishedAt 由调用方算好：
// 只有 status='published' 才非 NULL——ck_releases_published_at 是硬约束。
func upsertRelease(ctx context.Context, q sqlExec, publicID uuid.UUID, in UpsertReleaseInput, publishedAt *time.Time) (int64, error) {
	var id int64
	var channel any
	if in.Channel != "" {
		channel = in.Channel
	}
	err := row1(ctx, q, `
INSERT INTO releases (public_id, version, channel, notes_md, notes_html, status, published_at, created_at, updated_at)
VALUES ($1, $2, COALESCE($3::text, 'stable'), $4, $5, COALESCE($6::text, 'draft'), $7, now(), now())
ON CONFLICT (version) DO UPDATE
   SET channel      = COALESCE($3::text, releases.channel),
       notes_md     = EXCLUDED.notes_md,
       notes_html   = EXCLUDED.notes_html,
       status       = COALESCE($6::text, releases.status),
       published_at = CASE
                        WHEN COALESCE($6::text, releases.status) <> 'published' THEN NULL
                        WHEN releases.status =  'published' THEN releases.published_at
                        ELSE EXCLUDED.published_at
                      END,
       updated_at   = now()
RETURNING id, public_id`,
		[]any{publicID, in.Version, channel, in.NotesMD, in.NotesHTML, nullIfEmpty(in.Status), publishedAt},
		&id, &publicID)
	if err != nil {
		return 0, fmt.Errorf("release: upsert %s: %w", in.Version, err)
	}
	return id, nil
}

func countAssets(ctx context.Context, q sqlExec, releaseID int64) (int, error) {
	var n int
	if err := row1(ctx, q, "SELECT count(*) FROM release_assets WHERE release_id = $1", []any{releaseID}, &n); err != nil {
		return 0, fmt.Errorf("release: count assets: %w", err)
	}
	return n, nil
}

// releaseStatus 读一行状态与 public_id（改状态时判当前态与幂等）。
func releaseStatus(ctx context.Context, q sqlExec, releaseID int64) (publicID string, status string, publishedAt *time.Time, err error) {
	var pid uuid.UUID
	err = row1(ctx, q, "SELECT public_id, status, published_at FROM releases WHERE id = $1",
		[]any{releaseID}, &pid, &status, &publishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", nil, nil
	}
	if err != nil {
		return "", "", nil, fmt.Errorf("release: read status: %w", err)
	}
	return pid.String(), status, publishedAt, nil
}

// setReleaseStatus 改状态并维护 published_at（首次 publish 写一次，之后不改）。
func setReleaseStatus(ctx context.Context, q sqlExec, releaseID int64, status string, publishedAt *time.Time) error {
	_, err := q.ExecContext(ctx, `
UPDATE releases
   SET status = $2, published_at = $3, updated_at = now()
 WHERE id = $1`, releaseID, status, publishedAt)
	if err != nil {
		return fmt.Errorf("release: set status: %w", err)
	}
	return nil
}

// upsertAsset 按 uq_release_assets_slot 幂等写入。
func upsertAsset(ctx context.Context, q sqlExec, releaseID int64, publicID uuid.UUID, in UpsertAssetInput) (Asset, error) {
	var a Asset
	var pid uuid.UUID
	err := row1(ctx, q, `
INSERT INTO release_assets (public_id, release_id, platform, arch, url, size, sha256, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, now())
ON CONFLICT (release_id, platform, arch) DO UPDATE
   SET url = EXCLUDED.url, size = EXCLUDED.size, sha256 = EXCLUDED.sha256
RETURNING public_id, platform, arch, url, size, sha256, download_count`,
		[]any{publicID, releaseID, in.Platform, in.Arch, in.URL, in.Size, in.SHA256},
		&pid, &a.Platform, &a.Arch, &a.URL, &a.Size, &a.SHA256, &a.DownloadCount)
	if err != nil {
		return Asset{}, fmt.Errorf("release: upsert asset: %w", err)
	}
	a.ID = pid.String()
	return a, nil
}

func deleteAsset(ctx context.Context, q sqlExec, publicID string) (bool, error) {
	id, err := uuid.Parse(publicID)
	if err != nil {
		return false, nil
	}
	var got uuid.UUID
	err = row1(ctx, q, "DELETE FROM release_assets WHERE public_id = $1 RETURNING public_id", []any{id}, &got)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("release: delete asset: %w", err)
	}
	return true, nil
}

// resolveAsset 取转链需要的 URL 与版本状态（d5 §5.2）：草稿与归档不对外。
func resolveAsset(ctx context.Context, q sqlExec, publicID string) (id int64, url string, status string, err error) {
	aid, perr := uuid.Parse(publicID)
	if perr != nil {
		return 0, "", "", nil
	}
	err = row1(ctx, q, `
SELECT a.id, a.url, r.status
  FROM release_assets a JOIN releases r ON r.id = a.release_id
 WHERE a.public_id = $1`, []any{aid}, &id, &url, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", "", nil
	}
	if err != nil {
		return 0, "", "", fmt.Errorf("release: resolve asset: %w", err)
	}
	return id, url, status, nil
}

// addDownloadCounts 是计数写回（d5 §5.2）：增量而非赋值，主键索引逐行查找。
func addDownloadCounts(ctx context.Context, q sqlExec, ids []int64, deltas []int64) error {
	_, err := q.ExecContext(ctx, `
UPDATE release_assets
   SET download_count = download_count + v.n
  FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS n) v
 WHERE release_assets.id = v.id`, ids, deltas)
	if err != nil {
		return fmt.Errorf("release: flush downloads: %w", err)
	}
	return nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
