// Package pgsql 是 site 的原生 SQL 落点（开发必读 §1 第 8 条：原生 SQL 只放在各模块的 pgsql 子包）。
//
// 为什么这几条不是 ent：
//   - 站点设置的写入是**条件 upsert**（ON CONFLICT (key) DO UPDATE），ent 表达不了；
//   - 域名登记与横幅「不再显示」都要求「冲突即无事」，也要 ON CONFLICT DO NOTHING；
//   - 定向角色是一次「删了再插」的整表替换，放在同一个事务里更清楚。
//
// 参数处一律显式转型（_P2-修正清单 §7 第 7 类：PG 会把未定型的参数推断成 text/interval）。
package pgsql

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	ent "forum/internal/ent"
)

type execQuery interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

type Queries struct{ db execQuery }

func New(db *ent.Client) *Queries { return &Queries{db: db} }

func NewTx(tx *ent.Tx) *Queries { return &Queries{db: tx} }

// ---- 站点设置 ----

// SettingRow 是 site_settings 的一行（设置缓存的原料）。
type SettingRow struct {
	Key       string
	Value     string
	UpdatedAt time.Time
}

const settingsSQL = `SELECT key, value, updated_at FROM site_settings ORDER BY key`

// Settings 读整表：十几行，Seq Scan 是正确计划（d6 §7.13）。
func (q *Queries) Settings(ctx context.Context) ([]SettingRow, error) {
	rows, err := q.db.QueryContext(ctx, settingsSQL)
	if err != nil {
		return nil, fmt.Errorf("读站点设置: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []SettingRow
	for rows.Next() {
		var r SettingRow
		if err := rows.Scan(&r.Key, &r.Value, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("读站点设置: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

const settingsByKeysSQL = `SELECT key, value FROM site_settings WHERE key = ANY($1::varchar[])`

// SettingsByKeys 读若干键的**旧值**（审计的 before）。缺的键不在返回里 —— 调用方按 "" 处理。
func (q *Queries) SettingsByKeys(ctx context.Context, keys []string) (map[string]string, error) {
	out := make(map[string]string, len(keys))
	if len(keys) == 0 {
		return out, nil
	}
	rows, err := q.db.QueryContext(ctx, settingsByKeysSQL, keys)
	if err != nil {
		return nil, fmt.Errorf("读旧站点设置: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, fmt.Errorf("读旧站点设置: %w", err)
		}
		out[k] = v
	}
	return out, rows.Err()
}

const upsertSettingSQL = `INSERT INTO site_settings (key, value, updated_at)
VALUES ($1::varchar, $2::text, $3::timestamptz)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`

// UpsertSetting 是单键 upsert（d6 §7.12）：冲突走 key 上的唯一索引。
func (q *Queries) UpsertSetting(ctx context.Context, key, value string, now time.Time) error {
	if _, err := q.db.ExecContext(ctx, upsertSettingSQL, key, value, now.UTC()); err != nil {
		return fmt.Errorf("写站点设置 %s: %w", key, err)
	}
	return nil
}

// ---- 域名白名单 ----

const insertDomainSQL = `INSERT INTO site_domains (domain, created_at) VALUES ($1::varchar, $2::timestamptz)
ON CONFLICT (domain) DO NOTHING`

// InsertDomain 登记一个域名；返回 true 表示这次真的插进去了（首次登记 Warn 一次）。
func (q *Queries) InsertDomain(ctx context.Context, domain string, now time.Time) (bool, error) {
	res, err := q.db.ExecContext(ctx, insertDomainSQL, domain, now.UTC())
	if err != nil {
		return false, fmt.Errorf("登记域名 %s: %w", domain, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Domains 按字典序返回白名单（后台只读展示）。
func (q *Queries) Domains(ctx context.Context) ([]string, error) {
	rows, err := q.db.QueryContext(ctx, "SELECT domain FROM site_domains ORDER BY domain")
	if err != nil {
		return nil, fmt.Errorf("读域名白名单: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, fmt.Errorf("读域名白名单: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ---- 横幅 ----

const insertDismissalSQL = `INSERT INTO banner_dismissals (banner_id, user_id, created_at)
VALUES ($1::bigint, $2::bigint, $3::timestamptz)
ON CONFLICT (banner_id, user_id) DO NOTHING`

// InsertDismissal 是幂等的「不再显示」（d6 §7.11）：连点多少次都只留一行。
func (q *Queries) InsertDismissal(ctx context.Context, bannerID, userID int64, now time.Time) error {
	if _, err := q.db.ExecContext(ctx, insertDismissalSQL, bannerID, userID, now.UTC()); err != nil {
		return fmt.Errorf("记横幅 dismiss: %w", err)
	}
	return nil
}

const rolesByBannersSQL = `SELECT br.banner_id, r.key
  FROM banner_roles br
  JOIN roles r ON r.id = br.role_id
 WHERE br.banner_id = ANY($1::bigint[])
 ORDER BY br.banner_id, r.key`

// RolesByBanners 一次取回一页横幅的定向角色（key，按字典序）。
// 返回的 map 里没有键 = 这条横幅没有定向行 = 所有人（拍板 §8.11 U10）。
func (q *Queries) RolesByBanners(ctx context.Context, bannerIDs []int64) (map[int64][]string, error) {
	out := make(map[int64][]string, len(bannerIDs))
	if len(bannerIDs) == 0 {
		return out, nil
	}
	rows, err := q.db.QueryContext(ctx, rolesByBannersSQL, bannerIDs)
	if err != nil {
		return nil, fmt.Errorf("读横幅定向: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var key string
		if err := rows.Scan(&id, &key); err != nil {
			return nil, fmt.Errorf("读横幅定向: %w", err)
		}
		out[id] = append(out[id], key)
	}
	return out, rows.Err()
}

const roleIDsByKeysSQL = `SELECT id, key FROM roles WHERE key = ANY($1::text[])`

// RoleIDsByKeys 把角色 key 换成内部 id；不存在的 key 不会出现在结果里（调用方据此报 400）。
func (q *Queries) RoleIDsByKeys(ctx context.Context, keys []string) (map[string]int64, error) {
	out := make(map[string]int64, len(keys))
	if len(keys) == 0 {
		return out, nil
	}
	rows, err := q.db.QueryContext(ctx, roleIDsByKeysSQL, keys)
	if err != nil {
		return nil, fmt.Errorf("读角色: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var key string
		if err := rows.Scan(&id, &key); err != nil {
			return nil, fmt.Errorf("读角色: %w", err)
		}
		out[key] = id
	}
	return out, rows.Err()
}

// ReplaceBannerRoles 整表替换一条横幅的定向（在同一事务里删了再插）。
// keys 必须已去重排序（调用方 normalizeRoles 保证），否则同一次插入会撞唯一索引。
func (q *Queries) ReplaceBannerRoles(ctx context.Context, bannerID int64, byKey map[string]int64, keys []string) error {
	if _, err := q.db.ExecContext(ctx,
		"DELETE FROM banner_roles WHERE banner_id = $1::bigint", bannerID); err != nil {
		return fmt.Errorf("清横幅定向: %w", err)
	}
	for _, k := range keys {
		if _, err := q.db.ExecContext(ctx,
			"INSERT INTO banner_roles (banner_id, role_id) VALUES ($1::bigint, $2::bigint)",
			bannerID, byKey[k]); err != nil {
			return fmt.Errorf("写横幅定向 %s: %w", k, err)
		}
	}
	return nil
}
