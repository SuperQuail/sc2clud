package forum

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/db"
	"forum/internal/platform/queue"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// 人工审核队列（2026-10-14 补）。契约：完全重构/进行中/后端接口对账.md。
//
// **为什么这块是非补不可的**：AI 判定只有「明确合规」才写 approved（d7 §1 的实现口径），
// 拿不准的一律留在 pending；而公开流的可见性谓词只有一条：
// visibility='normal' AND review_state='approved'（pgsql/topics.go 的列表 SQL）。
// 于是「AI 拿不准」= 帖子从首页、分区页、搜索、个人主页全部消失，作者只看到审核横幅 ——
// **而在补这一块之前，没有任何端点能把 pending 变成 approved**：
// 队列索引 idx_topics_review_queue 从 0004 就建好了，一直是空的。
//
// 这一版只补人工那一侧；AI 的口径（谁能放行、放行时写什么）一个字都没动。

// 队列档位。**没有 approved**：它不是队列要做的事，而且部分索引的谓词是
// review_state <> 'approved'，查它用不上索引（等于全表扫）。
const (
	ReviewQueuePending  = "pending"
	ReviewQueueRejected = "rejected"
	ReviewQueueAll      = "all"
)

// 判定动作。**没有 request_revision**：topics.review_state 只有三值
// （0004 的 ck_topics_review_state），而「请求修改」在作者那一侧与 rejected 完全同形 ——
// 同一张横幅、同一条 review_note。加第四态是 schema 变更而没有用户可感知的差别。
// 作者改完 1 楼正文会经 ResetTopicReview 自动回到 pending（pgsql/topics.go），闭环不缺这一环。
const (
	ReviewApprove = "approve"
	ReviewReject  = "reject"
)

// AuditReviewAction 是人工判定的审计动作名（AI 那一侧是 topic.ai_hide）。
const AuditReviewAction = "topic.review"

const (
	maxReviewNote = 500 // review_note 是 varchar(500)
	maxReviewQ    = 100 // 队列搜索词上限（防 ILIKE 全表扫被滥用）
)

var (
	reviewQueueStates  = map[string]bool{ReviewQueuePending: true, ReviewQueueRejected: true, ReviewQueueAll: true}
	reviewQueueActions = map[string]bool{ReviewApprove: true, ReviewReject: true}
)

// ReviewQueueInput 是 GET /admin/topics 的入参。
type ReviewQueueInput struct {
	State  string // 空 = pending
	Board  string // slug，空 = 全部
	Q      string // 标题 / 用户名 / 昵称的模糊匹配
	Cursor string
	Limit  int
}

// ReviewQueueItemDTO 是队列项（JSON 字段名即契约）。
// 与 TopicCardDTO 分开：队列要的是「审核相关的列」（AI 说了什么、谁判的），
// 而卡片要的是「读者看的列」（回复数、封面）。硬把两者合成一个 DTO 会让两边都长出没人用的字段。
type ReviewQueueItemDTO struct {
	ID          string       `json:"id"`
	Board       BoardRefDTO  `json:"board"`
	Author      UserBriefDTO `json:"author"`
	Kind        string       `json:"kind"`
	Title       string       `json:"title"`
	Excerpt     string       `json:"excerpt"`
	ReviewState string       `json:"review_state"`
	// ReviewNote 是当前生效的那条理由：AI 判的与人工写的都落在这一列（谁写的看 review_source）。
	// 没有第三列可读 —— topics 表从来就没有 ai_review_note。
	ReviewNote   *string   `json:"review_note"`
	ReviewSource *string   `json:"review_source"`
	CreatedAt    time.Time `json:"created_at"`
}

// ReviewQueuePage 是队列一页（{ data, next_cursor }）。
type ReviewQueuePage struct {
	Items      []ReviewQueueItemDTO
	NextCursor string
}

// ListReviewQueue 是待审 / 已拒主题的队列（游标分页，created_at DESC）。
func (s *Service) ListReviewQueue(ctx context.Context, actor *authz.Actor, in ReviewQueueInput) (*ReviewQueuePage, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermPostReview); err != nil {
		return nil, err
	}
	state := in.State
	if state == "" {
		state = ReviewQueuePending
	}
	if !reviewQueueStates[state] {
		return nil, invalid("state", "只能是 pending / rejected / all")
	}
	q := strings.TrimSpace(in.Q)
	if len([]rune(q)) > maxReviewQ {
		return nil, invalid("q", "最多 100 字")
	}
	cursorT, cursorID, err := pageCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	rows, err := s.repo.ReviewQueue(ctx, state, in.Board, q, cursorT, cursorID, limit)
	if err != nil {
		return nil, err
	}
	items := make([]ReviewQueueItemDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, reviewQueueItemDTO(r))
	}
	return &ReviewQueuePage{
		Items:      items,
		NextCursor: nextCursor(rows, limit, func(r pgsql.ReviewQueueRow) (time.Time, int64) { return r.CreatedAt, r.ID }),
	}, nil
}

// ReviewTopic 是人工判定：approve | reject。三条副作用**与判定同事务**：
// 改 topics 的三列 + 一行审计 + 一条给作者的通知任务（队列是至少一次投递，
// 判定本身是幂等的 —— 再判一次就是又写一次同样的值）。
func (s *Service) ReviewTopic(ctx context.Context, actor *authz.Actor, publicID, action, note string) (*ReviewQueueItemDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermPostReview); err != nil {
		return nil, err
	}
	if !reviewQueueActions[action] {
		return nil, invalid("action", "只能是 approve / reject")
	}
	note = strings.TrimSpace(note)
	if len([]rune(note)) > maxReviewNote {
		return nil, invalid("note", "最多 500 字")
	}
	// 不通过必须给理由：作者在帖子页看到的就是这条 review_note（topic-view 的审核横幅）。
	// 允许空理由等于让作者收到一条「未通过」而不知道为什么。
	if action == ReviewReject && note == "" {
		return nil, invalid("note", "不通过必须写理由（作者能看到）")
	}

	ref, err := s.repo.TopicRef(ctx, publicID, actor.UserID, true)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrTopicNotFound
		}
		return nil, err
	}
	if ref.Visibility == "deleted" {
		return nil, ErrTopicNotFound
	}

	now := s.clk.Now()
	state := "approved"
	var notePtr *string
	if action == ReviewReject {
		state = "rejected"
		notePtr = &note
	}
	detail, err := json.Marshal(map[string]any{
		"action": action, "state": state, "note": note, "from": ref.ReviewState,
	})
	if err != nil {
		return nil, err
	}

	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		n, err := pgsql.SetTopicReview(ctx, tx, ref.ID, state, notePtr, actor.UserID, now)
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrTopicNotFound
		}
		if err := pgsql.InsertReviewAudit(ctx, tx, actor.UserID, AuditReviewAction, publicID, detail, now); err != nil {
			return err
		}
		// 通知作者（d4 §5.1 ⑤）：actor 由 notify 侧从 topics.reviewed_by 现读，
		// 所以这里只需要 ref_id。**不设 UniqueKey**：两次判定是两条通知，去重会把后一条吃掉。
		return s.enqueue(ctx, tx, queue.Task{
			Type:    queue.TypeNotifyReview,
			Payload: map[string]any{"ref_type": notifyRefTopic, "ref_id": ref.ID, "topic_id": ref.ID},
		})
	})
	if err != nil {
		return nil, err
	}

	row, err := s.repo.ReviewQueueItem(ctx, ref.ID)
	if err != nil {
		return nil, err
	}
	item := reviewQueueItemDTO(*row)
	return &item, nil
}

func reviewQueueItemDTO(r pgsql.ReviewQueueRow) ReviewQueueItemDTO {
	return ReviewQueueItemDTO{
		ID:           r.PublicID,
		Board:        BoardRefDTO{Slug: r.BoardSlug, Name: r.BoardName},
		Author:       userBriefDTO(r.Author),
		Kind:         r.Kind,
		Title:        r.Title,
		Excerpt:      r.Excerpt,
		ReviewState:  r.ReviewState,
		ReviewNote:   r.ReviewNote,
		ReviewSource: r.ReviewSource,
		CreatedAt:    r.CreatedAt.UTC(),
	}
}
