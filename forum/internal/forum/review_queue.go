package forum

import (
	"context"
	"encoding/json"
	"errors"
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
//
// **draft 是 06.2 加的那一档**（唯一一个 review_state='approved' 的档）：
// 「线上还挂着旧版、改动等着替换上线」。用户要的是「编辑不动原帖、通过再替换」，
// 而这一步替换必须有人能批 —— 少了这一档，发布过的帖子改完就**永远上不了台**。
const (
	ReviewQueuePending  = "pending"
	ReviewQueueRejected = "rejected"
	ReviewQueueAll      = "all"
	ReviewQueueDraft    = "draft"
)

// 判定动作。
//
//   - approve / reject 是原来的两条；
//   - **request_revision 是第四态**（拍板 08 · L6）：用户要的是「改改就能过」与「直接拒绝」
//     分开 —— 对作者是不同的心理预期，所以它不再是「与 rejected 完全同形」的那条。
//     打回期间**只有作者可见**（可见性谓词天然如此：只有 approved 对所有人可见），
//     作者看到的是**最后一个过审版本**（topic_revisions，迁移 0028）。
//
// 作者改完 1 楼正文会经 ResetTopicReview 自动回到 pending（pgsql/topics.go），闭环不走缺环。
const (
	ReviewApprove         = "approve"
	ReviewReject          = "reject"
	ReviewRequestRevision = "request_revision"
)

// ReviewStateRevisionRequested 是第四态在库里的值（迁移 0028 的 CHECK 值域）。
// 它同时是**作者侧横幅的判据**：TopicDetailDTO.ReviewState 与 RevisionOf 一起给出，
// 前端据此渲染「按审核意见改一版」而不是「未通过」。
const ReviewStateRevisionRequested = "revision_requested"

// AuditReviewAction 是人工判定的审计动作名（AI 那一侧是 topic.ai_hide）。
const AuditReviewAction = "topic.review"

// ReviewSourceManual 是 review_events.source / topics.review_source 的「人判的」那一值
// （值域 ai|manual|trusted，0020）。**AI 见到 manual 直接返回**（d7 §1 铁律）。
const ReviewSourceManual = "manual"

const (
	maxReviewNote = 500 // review_note 是 varchar(500)
	maxReviewQ    = 100 // 队列搜索词上限（防 ILIKE 全表扫被滥用）
)

var (
	// 队列还有第四档（拍板 08 · L6）：打回修改的那些帖**也要在队列里有一档**，
	// 否则「谁被打回了、改到哪一步了」在后台看不见。索引谓词是 review_state <> 'approved'，
	// 第四态自动在索引里，所以这一档不多花代价。
	reviewQueueStates = map[string]bool{
		ReviewQueuePending: true, ReviewQueueRejected: true,
		ReviewStateRevisionRequested: true, ReviewQueueAll: true,
		// 待替换上线的那一档（06.2）：批准了它 = 把改动换上线上。
		ReviewQueueDraft: true,
	}
	reviewQueueActions = map[string]bool{ReviewApprove: true, ReviewReject: true, ReviewRequestRevision: true}
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
	ReviewNote   *string `json:"review_note"`
	ReviewSource *string `json:"review_source"`
	// Reviewer 是**上一次判定人**（AI 判的 → null），ReviewedAt 是那一次的时间。
	// 设计稿的审核屏要显示「谁判的、判过几次」；判定历史本身在 review_events，这里只带上最近一次。
	Reviewer   *UserBriefDTO `json:"reviewer"`
	ReviewedAt *time.Time    `json:"reviewed_at"`
	// ReviewVerdict 是**最近一次判定事件**的结论：approve | reject | review（"review" = AI 转人工，
	// 审核屏要把它挑出来）| null（还没判过）。取自 review_events，不是从 review_state 推导 ——
	// topics 只有三态，推不出 'review' 那一档，而它恰恰是审核员最先要看的一类。
	ReviewVerdict *string   `json:"review_verdict"`
	CreatedAt     time.Time `json:"created_at"`
	// UpdatedAt 是内容的版本号：**判定时必须原样回传**（expected_updated_at）。
	// 不回传就退化成「只比 review_state」，而作者在你读队列之后改正文时状态不变、内容变了。
	UpdatedAt time.Time `json:"updated_at"`
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
		return nil, invalid("state", "只能是 pending / rejected / revision_requested / draft / all")
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
// expectedUpdatedAt 是**审核员看队列时那一版的版本号**（队列项的 updated_at）。
//
// 为什么必须有它：只比 review_state 抓不到「作者在审核员看队列之后改了正文」——
// 那时主题是 pending → pending，状态一个字没变、正文换了一份，批准等于放出一份没人看过的内容
// （盲测 X4 实测：回执里 excerpt 已经是作者改后的新正文，仍然 200）。
// HTTP 层把它设为**必填**（信任边界在 handler）；内部调用方可以不给（nil = 不校验版本）。
func (s *Service) ReviewTopic(ctx context.Context, actor *authz.Actor, publicID, action, note string,
	expectedUpdatedAt ...time.Time) (*ReviewQueueItemDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermPostReview); err != nil {
		return nil, err
	}
	if !reviewQueueActions[action] {
		return nil, invalid("action", "只能是 approve / reject / request_revision")
	}
	note = strings.TrimSpace(note)
	if len([]rune(note)) > maxReviewNote {
		return nil, invalid("note", "最多 500 字")
	}
	// 不通过 / 打回都必须给理由：作者在帖子页看到的就是这条 review_note（topic-view 的审核横幅）。
	// 允许空理由等于让作者收到一条「未通过」而不知道为什么 —— 打回更糟：
	// 「改改就能过」但不说改哪里，等于让作者猜。
	if (action == ReviewReject || action == ReviewRequestRevision) && note == "" {
		return nil, invalid("note", "不通过 / 打回必须写理由（作者能看到）")
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
	switch action {
	case ReviewReject:
		state = "rejected"
		notePtr = &note
	case ReviewRequestRevision:
		state = ReviewStateRevisionRequested
		notePtr = &note
	}
	detail, err := json.Marshal(map[string]any{
		"action": action, "state": state, "note": note, "from": ref.ReviewState,
	})
	if err != nil {
		return nil, err
	}

	// 待审版本读在事务**之外**（下面判定时用它的内容替换线上正文）。
	// 它读的是同一个事务开始前的快照：作者在这之后、行锁之前又改一版的话，
	// 被放行的是审核员看到的那一版，而作者的新草稿会被这次放行覆盖掉
	// （shortcut: 判定与改稿并发时不重读待审槽，真需要时在行锁之后加一次 SELECT ... FOR UPDATE）。
	pendingMD := ""
	if pending, err := s.repo.PendingRevision(ctx, ref.ID); err != nil {
		return nil, err
	} else if pending != nil {
		pendingMD = pending.ContentMD
	}

	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		// 判定必须基于**刚读到的那个状态**做。作者可能在上面那次无锁读之后改了正文
		// （PATCH 带 content_md → ResetTopicReview 打回 pending），那时把新内容写成 approved
		// 等于放行一份没人看过的内容。行锁 + 重读 + 把状态写进 UPDATE 的 WHERE：
		// 两者不一致就是 0 行 → 冲突错，请管理员刷新队列重判。
		locked, err := pgsql.TopicRefForUpdate(ctx, tx, ref.ID)
		if err != nil {
			if errors.Is(err, pgsql.ErrNoRows) {
				return ErrTopicNotFound
			}
			return err
		}
		// 状态或内容版本任一对不上，都说明审核员看的那一版已经不是现在这一版
		if locked.ReviewState != ref.ReviewState {
			return reviewStale()
		}
		var expect *time.Time
		if len(expectedUpdatedAt) > 0 && !expectedUpdatedAt[0].IsZero() {
			expect = &expectedUpdatedAt[0]
		}
		// 放行一份**草稿**时，线上正文会被换成草稿的内容，而版本号必须跟着换到同一个时刻：
		// 判定的时刻由 service 说了算（PromotePendingRevision 用的也是它）。
		var alsoUpdatedAt *time.Time
		if action == ReviewApprove && pendingMD != "" {
			alsoUpdatedAt = &now
			// 放行一份草稿 = 帖子重新上线：状态必须回到 approved。
			// 打回态（revision_requested）的帖也有草稿，若把修订态原样留在库里，
			// 读者仍然是 404 —— 「通过再替换」就只替换了一半。
			state = "approved"
		}
		n, err := pgsql.SetTopicReview(ctx, tx, ref.ID, state, notePtr, actor.UserID,
			action == ReviewApprove, locked.ReviewState, expect, alsoUpdatedAt, now)
		if err != nil {
			return err
		}
		if n == 0 {
			// 版本/状态在事务里对不上（0 行）—— 不是「不存在」，是「你该刷新重判」
			if expect != nil {
				return reviewStale()
			}
			return ErrTopicNotFound
		}
		if err := pgsql.InsertReviewAudit(ctx, tx, actor.UserID, AuditReviewAction, publicID, detail, now); err != nil {
			return err
		}
		// 判定历史（M4）：audit_logs 是操作流水，review_events 才是「这条主题被谁、
		// 因为什么、判过几次」—— 后台审核屏要的就是后者。0021 还专门给 actor_id 补了索引。
		// 与判定同事务：判定没落库就不该留下一条事件。
		reviewerID := actor.UserID
		// verdict 用**状态名**而不是动作名：动作是 API 的词（request_revision），
		// 状态是库里的值（revision_requested，ck_review_events_verdict 与 ck_topics_review_state 同域）。
		// 两个词长得像但不是同一个东西 —— 把动作原样写进去会撞 CHECK（23514）整条回滚。
		verdict := action
		if action == ReviewRequestRevision {
			verdict = ReviewStateRevisionRequested
		}
		if err := pgsql.InsertReviewEvent(ctx, tx, ref.ID, ReviewSourceManual, verdict, note,
			&reviewerID, now); err != nil {
			return err
		}
		// 「通过再替换」（拍板 08 第二轮 · 6.2）：作者改的正文一直存在待审槽里（UpdateTopic），
		// 线上那一份在 posts 里没动过 —— **放行这一刻才把它换上去**，换完清空待审槽。
		//
		// 先 Promote 再 Snapshot 的顺序不能反：Promote 把 posts 换成新版并同步快照行，
		// 而 SnapshotApprovedRevision 读的是 posts、且 NOT EXISTS（已有行时它什么都不做）。
		if action == ReviewApprove && pendingMD != "" {
			html, plain, err := s.render(pendingMD)
			if err != nil {
				return err
			}
			if err := s.repo.PromotePendingRevision(ctx, tx, ref.ID, actor.UserID, pendingMD, html,
				clipExcerpt(plain), now); err != nil {
				return err
			}
		} else if action == ReviewApprove && locked.ReviewState == "approved" {
			// 走这条路 = 作者在打回后**没改正文**，或者这是一次重复批准。此时 1 楼正文
			// 就是被批准的那一份，快照下来即可。
			//
			// 两个条件都是必需的，少一个都会让「最后过审版本」变成假话：
			//   · 上一态就是 approved（locked.ReviewState，**行锁下重读的那一版**）——
			//     一条 pending 的新帖第一次被批准时，它此前没有任何过审内容，而 1 楼正文就在
			//     这次批准之后的库里：写一份「还没审过的正文」进 topic_revisions，
			//     作者在 revision_of 里会看到一份从没被批准过的内容。
			//   · 还没有快照（HasApprovedRevision）—— 快照一旦写下就不该被同内容覆盖
			//     （approved_at 说的是「这份内容什么时候被批准」，覆盖会让那个时间戳说谎）。
			has, err := s.repo.HasApprovedRevision(ctx, tx, ref.ID)
			if err != nil {
				return err
			}
			if !has {
				if err := pgsql.SnapshotApprovedRevision(ctx, tx, ref.ID, actor.UserID, now); err != nil {
					return err
				}
			}
		}
		// 放行必须重建搜索索引：indexTopic 对「未过审」的主题是**把索引行删掉**（app/tasks.go），
		// 而 search:index 只由发帖/改帖/删帖入队 —— 少了这一条，人工放行的帖子在搜索里
		// **永远**不存在（只有作者再改一次正文才会补上）。
		if err := s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeSearchIndex, Payload: map[string]int64{"id": ref.ID},
			UniqueKey: "topic:" + itoa64(ref.ID),
		}); err != nil {
			return err
		}
		// 通知作者（d4 §5.1 ⑤）：actor 由 notify 侧从 topics.reviewed_by 现读。
		// **state/text 必须随 payload 走**（判定那一刻的快照）：任务是至少一次投递、可能延迟消费，
		// 现读 topics 时「拒绝（带理由）→ 紧接着放行」会把两条任务都读成后一个状态，
		// 作者的拒绝理由一个字都送不到（M5，2026-10-14）。判定那一刻的事实只有这里知道。
		// **不设 UniqueKey**：两次判定是两条通知，去重会把后一条吃掉。
		return s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeNotifyReview,
			Payload: map[string]any{
				"ref_type": notifyRefTopic, "ref_id": ref.ID, "topic_id": ref.ID,
				"state": state, "text": note,
			},
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

// reviewStale 是「你手上的那一版不是现在这一版」：让审核员刷新队列重判，而不是把
// 一份没人看过的内容写成 approved、或者覆盖掉别人刚做的判定。
func reviewStale() error {
	return invalid("state", "这条主题在你判定之前变过（作者改了正文或别人判过），请刷新队列后再判")
}

func reviewQueueItemDTO(r pgsql.ReviewQueueRow) ReviewQueueItemDTO {
	d := ReviewQueueItemDTO{
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
		// UpdatedAt 就是「我看到的是哪一版」，判定时原样回传（HTTP 层必填）
		UpdatedAt: r.UpdatedAt.UTC(),
	}
	if r.Reviewer != nil {
		rv := userBriefDTO(*r.Reviewer)
		d.Reviewer = &rv
	}
	if r.ReviewedAt != nil {
		at := r.ReviewedAt.UTC()
		d.ReviewedAt = &at
	}
	d.ReviewVerdict = r.Verdict
	return d
}
