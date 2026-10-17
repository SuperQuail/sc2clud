package aireview

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"forum/internal/platform/ai"
	"forum/internal/platform/apperr"
)

// D63(b)：审核历史的**查询面**。d7 §5.2 建了 review_events（只增不改），管理端也从它读
// 「最近一次」，但「它被谁、因为什么、判过几次」一直没有列表读口 —— 审核屏的面板里写着
// 「要多次判定历史得先给队列加一个读口」，这就是那个读口。
//
// 端点：GET /api/v1/admin/ai/events（cursor 分页，包络 {data, next_cursor}，与用户列表、
// 审计日志同一个形状）。权限沿用审核本身的 post.review（Register 处）：能看到队列的人
// 本来就要看到判定理由，不沿用配置那一档的 site.setting —— 配置与判定不是一个受众。
//
// 表上没有「原图 / 正文」可以说：review_events 只存判定与 ≤200 字的理由（d7 §5.2 的取舍：
// 内容历史我们不做，正文永远在 topics 里），这个读口也照实只给字段。

// eventsQuery 是 GET /admin/ai/events 的入参（筛两根轴：/source/verdict — 0020 的两个 CHECK 值域）。
type EventsQuery struct {
	Verdict string // 空 = 全部（approve | reject | review）
	Source  string // 空 = 全部（ai | manual | trusted）
	Limit   int
	Cursor  string
}

// ReviewEventItem 是一条判定事件的对外形状（web 真源：web/src/lib/api/admin-types.ts 同名类型）。
// 字段名逐字照 review_events 的列：source/verdict/trigger 值域在 0020 的三个 CHECK 里。
// 没有分数（score）这个概念：d7 的判定只有三值 + 理由，库与外呼都不产生数字分数 —— 别编一个。
type ReviewEventItem struct {
	ID        int64     `json:"id"` // 自增 id 照样出：本表无 public_id，audit_logs 同例（auth/audit.go ListAuditLogs）
	CreatedAt time.Time `json:"created_at"`
	// TopicID 是 topics.public_id（uuid）：对外 id 纪律不变，前端拿它就能在两张屏之间对得上一条帖。
	TopicID      string   `json:"topic_id"`
	TopicTitle   string   `json:"topic_title"`
	Trigger      string   `json:"trigger"`
	Source       string   `json:"source"`
	Verdict      string   `json:"verdict"`
	Reason       string   `json:"reason"`
	Categories   []string `json:"categories"`
	Model        string   `json:"model"`
	LatencyMS    int      `json:"latency_ms"`
	ImageCount   int      `json:"image_count"`   // 判了几张（0053：事后重算会撒谎，记录自己带）
	ImageSkipped int      `json:"image_skipped"` // 被上限截掉几张
	// Actor 是判定人（人工判定才有）：AI 判定 → null，与审计「系统动作没有操作者」同一口径。
	Actor *EventActor `json:"actor"`
}

// EventActor 是判定人的展示字段（字段名照 auth.AuditActor）。
type EventActor struct {
	ID       string `json:"id"`
	Handle   string `json:"handle"`
	Nickname string `json:"nickname"`
}

// eventsRequest 是 handler 的查询串形状。
type eventsRequest struct {
	Verdict string `form:"verdict"`
	Source  string `form:"source"`
	Limit   int    `form:"limit"`
	Cursor  string `form:"cursor"`
}

// eventsCursor 是 (created_at DESC, id DESC) 的游标 —— base64url(JSON{k,id})，
// 与审计日志同一格式（auth/audit.go 的 auditCursor）：服务端自己发给自己，前端只回传不解释。
type eventsCursor struct {
	K  string `json:"k"` // RFC3339Nano
	ID int64  `json:"id"`
}

func encodeEventsCursor(t time.Time, id int64) string {
	b, _ := json.Marshal(eventsCursor{K: t.UTC().Format(time.RFC3339Nano), ID: id})
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeEventsCursor(s string) (time.Time, int64, error) {
	var c eventsCursor
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, 0, errBadEventsCursor
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return time.Time{}, 0, errBadEventsCursor
	}
	t, err := time.Parse(time.RFC3339Nano, c.K)
	if err != nil {
		return time.Time{}, 0, errBadEventsCursor
	}
	return t, c.ID, nil
}

// 伪造的游标是客户端 bug 或攻击：400，不是「当第一页静默吞掉」（auth/audit.go 同一条纪律）。
var errBadEventsCursor = apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})

// eventsLimit：拍板 §5.1 的展示偏好 —— 默认 20、上限 100，传大了收敛而不 400。
func eventsLimit(n int) int {
	switch {
	case n <= 0:
		return 20
	case n > 100:
		return 100
	default:
		return n
	}
}

// ListEvents 返回一页判定事件 + 下一页游标（空串 = 到底）。
//
// 筛选值在进 SQL 之前先校验：0020 的 ck_review_events_verdict / trigger 是 CHECK 挡着的第二道墙，
// 管理端不该靠 DB 报 23514 才知道「verdict=ok 是个坏参数」（D70 的另一处同款教训）。
func (s *Service) ListEvents(ctx context.Context, in EventsQuery) ([]ReviewEventItem, string, error) {
	switch in.Verdict {
	case "", string(ai.Approve), string(ai.Reject), string(ai.Review):
	default:
		return nil, "", apperr.Invalid(map[string]string{"verdict": "只能是 approve / reject / review"})
	}
	switch in.Source {
	case "", "ai", "manual", "trusted":
	default:
		return nil, "", apperr.Invalid(map[string]string{"source": "只能是 ai / manual / trusted"})
	}
	var cursorAt pgtype.Timestamptz
	var cursorID int64
	if in.Cursor != "" {
		t, id, err := decodeEventsCursor(in.Cursor)
		if err != nil {
			return nil, "", err
		}
		cursorAt = pgtype.Timestamptz{Time: t, Valid: true}
		cursorID = id
	}
	limit := eventsLimit(in.Limit)
	rows, err := s.pool.Query(ctx, sqlListEvents,
		nullString(in.Verdict), nullString(in.Source), cursorAt, cursorID, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	type eventsRow struct {
		ID                                  int64
		CreatedAt                           time.Time
		Trigger, Source, Verdict, Reason    string
		Categories                          []string
		Model                               string
		LatencyMS                           int
		ImageCount                          int
		ImageSkipped                        int
		TopicID, TopicTitle                 string
		ActorID, ActorHandle, ActorNickname *string
	}
	var out []ReviewEventItem
	for rows.Next() {
		var r eventsRow
		if err := rows.Scan(&r.ID, &r.CreatedAt, &r.Trigger, &r.Source, &r.Verdict, &r.Reason,
			&r.Categories, &r.Model, &r.LatencyMS, &r.ImageCount, &r.ImageSkipped,
			&r.TopicID, &r.TopicTitle, &r.ActorID, &r.ActorHandle, &r.ActorNickname); err != nil {
			return nil, "", err
		}
		item := ReviewEventItem{
			ID: r.ID, CreatedAt: r.CreatedAt, TopicID: r.TopicID, TopicTitle: r.TopicTitle,
			Trigger: r.Trigger, Source: r.Source, Verdict: r.Verdict, Reason: r.Reason,
			Categories: r.Categories, Model: r.Model, LatencyMS: r.LatencyMS,
			ImageCount: r.ImageCount, ImageSkipped: r.ImageSkipped,
		}
		if r.ActorID != nil {
			item.Actor = &EventActor{ID: *r.ActorID, Handle: *r.ActorHandle, Nickname: *r.ActorNickname}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		next = encodeEventsCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// nullString 把「空 = 不筛」表达成 SQL NULL（pgx 对 nil 发 NULL）。
func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
