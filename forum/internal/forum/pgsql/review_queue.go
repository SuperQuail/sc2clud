package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// 人工审核队列（2026-10-14 补）。为什么必须有这一侧，见 forum/review_queue.go 的文件头。
// 本文件是它的全部 SQL：列表 + 取一行 + 判定 + 审计。

// reviewQueueColumns 是两个查询共用的列清单（各写一份必然漂移）。
// 作者三列照抄 topicColumns 的写法：avatar_hash 空 → default_avatar_hash，
// 否则作者头像会退回首字母占位（dto.go 的 UserBriefDTO 注释）。
const reviewQueueColumns = `t.id, t.public_id::text, t.title, t.kind, COALESCE(t.excerpt, ''),
       t.review_state, t.review_note, t.review_source,
       b.slug, b.name,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username),
       COALESCE(NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''),
       COALESCE(NULLIF(a.avatar_small_hash, ''), NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), a.status,
       t.created_at, t.updated_at,
       ev.verdict, COALESCE(ev.created_at, t.reviewed_at),
       r.id, r.public_id, r.username, COALESCE(NULLIF(r.nickname, ''), r.username),
       COALESCE(NULLIF(r.avatar_hash, ''), r.default_avatar_hash, ''),
       COALESCE(NULLIF(r.avatar_small_hash, ''), NULLIF(r.avatar_hash, ''), r.default_avatar_hash, ''), r.status`

const reviewQueueFrom = `
  FROM topics t
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = t.author_id
  LEFT JOIN LATERAL (
    SELECT e.verdict, e.created_at, e.actor_id
      FROM review_events e WHERE e.topic_id = t.id
     ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) ev ON true
  LEFT JOIN users r ON r.id = ev.actor_id`

// ReviewQueueRow 是队列的一行：一屏要能判断「这是什么、谁写的、AI 说了什么」。
type ReviewQueueRow struct {
	ID       int64
	PublicID string
	Title    string
	Kind     string
	Excerpt  string
	// ReviewNote 是**当前生效**的那条理由：AI 判的与人工写的都落在这一列，
	// 谁写的看 ReviewSource（ai / manual / trusted）。没有第三列可读 —— 别再造一个 ai_review_note。
	ReviewState  string
	ReviewNote   *string
	ReviewSource *string
	BoardSlug    string
	BoardName    string
	Author       UserRow
	// Verdict / ReviewedAt / Reviewer 是**最近一次判定**（review_events 最新一条）的三个同源列，
	// 一起取一起不取（拆开就会出现「结论是 A 的、判的人是 B」）。没有判定事件时三样都是 NULL。
	// 为什么不读 topics.reviewed_by：AI 判定也会写 review_events 却不写 reviewed_by
	// （aireview/sql.go 的 sqlUpdateTopic 不碰那一列）—— 读它等于把「AI 转人工」显示成没人判过。
	// 时间用 COALESCE(ev.created_at, t.reviewed_at)：手工塞过 reviewed_at 而没有事件的老数据也兜得住。
	Verdict    *string
	ReviewedAt *time.Time
	Reviewer   *UserRow
	CreatedAt  time.Time
	// UpdatedAt 是**内容的版本**：作者改正文会经 ResetTopicReview 把它推新。
	// 判定时必须把它带回来（$8），否则「审核员看到的」与「他批的」可以是两份不同的正文。
	UpdatedAt time.Time
}

// scanReviewQueueRow 是那一列清单的唯一扫描器。
func scanReviewQueueRow(rows *sql.Rows, r *ReviewQueueRow) error {
	var note, source, avatar, avatarSmall sql.NullString
	// 判定人是可空的外键：LEFT JOIN + 一组可空标量，扫完再拼成一个可空的 UserRow
	// （与 issues.go 的指派人是同一套做法）。
	var (
		rvID                                 sql.NullInt64
		rvPublic, rvHandle, rvNick, rvStatus sql.NullString
		rvAvatar, rvAvatarSmall              sql.NullString
	)
	if err := rows.Scan(
		&r.ID, &r.PublicID, &r.Title, &r.Kind, &r.Excerpt,
		&r.ReviewState, &note, &source,
		&r.BoardSlug, &r.BoardName,
		&r.Author.ID, &r.Author.PublicID, &r.Author.Handle, &r.Author.Nickname,
		&avatar, &avatarSmall, &r.Author.Status,
		&r.CreatedAt, &r.UpdatedAt,
		&r.Verdict, &r.ReviewedAt,
		&rvID, &rvPublic, &rvHandle, &rvNick, &rvAvatar, &rvAvatarSmall, &rvStatus,
	); err != nil {
		return err
	}
	r.ReviewNote, r.ReviewSource = scanNullString(note), scanNullString(source)
	r.Author.AvatarHash = scanNullString(avatar)
	r.Author.AvatarSmall = scanNullString(avatarSmall)
	if rvID.Valid {
		r.Reviewer = &UserRow{
			ID: rvID.Int64, PublicID: rvPublic.String, Handle: rvHandle.String, Nickname: rvNick.String,
			AvatarHash: scanNullString(rvAvatar), AvatarSmall: scanNullString(rvAvatarSmall), Status: rvStatus.String,
		}
	}
	return nil
}

// ReviewQueue 吃 idx_topics_review_queue：部分索引
// (review_state, created_at DESC, id DESC) WHERE review_state <> 'approved'（0004）。
// 所以只允许查非 approved 的档 —— 查 approved 用不上这个索引，而「看已通过的」不是队列要做的事。
// 排序键 (created_at, id) 与索引逐字对齐；游标用 pageCursor 的哨兵，WHERE 里的行比较永远在。
func (s *Store) ReviewQueue(ctx context.Context, state, boardSlug, q string,
	cursorT time.Time, cursorID int64, limit int) ([]ReviewQueueRow, error) {
	out := make([]ReviewQueueRow, 0, limit)
	err := s.query(ctx, sqlJoin(
		"SELECT "+reviewQueueColumns+reviewQueueFrom,
		" WHERE t.visibility <> 'deleted'",
		"   AND ($1 = 'all' OR t.review_state = $1)",
		"   AND ($2 = '' OR b.slug = $2)",
		"   AND ($3 = '' OR t.title ILIKE '%' || $3 || '%'",
		"                OR a.username ILIKE '%' || $3 || '%'",
		"                OR COALESCE(a.nickname, '') ILIKE '%' || $3 || '%')",
		"   AND (t.created_at, t.id) < ($4, $5)",
		" ORDER BY t.created_at DESC, t.id DESC",
		" LIMIT $6",
	), []any{state, boardSlug, q, cursorT.UTC(), cursorID, limit},
		func(rows *sql.Rows) error {
			var r ReviewQueueRow
			if err := scanReviewQueueRow(rows, &r); err != nil {
				return err
			}
			out = append(out, r)
			return nil
		})
	return out, err
}

// ReviewQueueItem 按内部 id 取队列里的同一行：判定完要回执「更新后的那一条」，
// 而回执必须与列表逐字同形（否则前端要维护两种形状）。
func (s *Store) ReviewQueueItem(ctx context.Context, topicID int64) (*ReviewQueueRow, error) {
	var r ReviewQueueRow
	err := s.queryOne(ctx, "SELECT "+reviewQueueColumns+reviewQueueFrom+" WHERE t.id = $1",
		[]any{topicID}, func(rows *sql.Rows) error { return scanReviewQueueRow(rows, &r) })
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SetTopicReview 是人工判定的唯一落点。返回受影响行数：0 = 没这条主题或已删（service 换 404）。
//
//   - review_source 一律写 'manual'：AI 任务见到 manual 直接返回（d7 §1 铁律：AI 绝不覆盖人工判定）；
//   - $3 传 nil 表示「通过且不写理由」——review_note 被清空，上一版的拒绝理由不该留着；
//   - reviewed_by/reviewed_at 是 notify:review 取「审核人是谁」的唯一来源（notify/tasks.go:126）。
func SetTopicReview(ctx context.Context, tx Querier, topicID int64, state string, note *string,
	reviewerID int64, unhide bool, expectState string, expectUpdatedAt *time.Time, now time.Time) (int, error) {
	n, err := rowsAffected(ctx, tx, sqlJoin(
		"UPDATE topics",
		"   SET review_state  = $2,",
		"       review_note   = $3,",
		"       review_source = 'manual',",
		"       reviewed_by   = $4,",
		"       reviewed_at   = $5,",
		// $6 放行时把 visibility 还原成 normal。**不能省**：AI 复核 reject 会写 visibility='hidden'
		// （aireview/sql.go 的 sqlUpdateTopic），而全仓只有两处写 visibility —— AI 只写 hidden、
		// DeleteTopic 只写 deleted，**没有任何路径能改回 normal**。少了它：管理员点「通过」→
		// 队列里消失、作者收到「通过」通知、帖子在首页/分区/搜索/主页全看不到，前端又只看
		// review_state（连横幅都没有）—— 一个谁也修不回来的死状态。
		"       visibility    = CASE WHEN $6::boolean THEN 'normal' ELSE visibility END,",
		"       updated_at    = $5",
		// $7 只判「我读到的那一版」：作者在管理员点通过之前改了正文（PATCH 带 content_md 会回
		// pending 并换内容），这次判定就不该落到新内容上 —— 影响 0 行，service 换冲突错。
		// $8 是**内容的版本**。只比 review_state 不够：作者在审核员看队列之后改了正文时，
		// 主题是 pending → pending，状态一个字没变，而正文换了一份 —— 这时批准等于放出一份
		// 没人看过的内容。版本不符 → 0 行 → service 换冲突错，让审核员刷新重判。
		" WHERE id = $1 AND visibility <> 'deleted' AND review_state = $7",
		"   AND ($8::timestamptz IS NULL OR updated_at = $8)",
	), topicID, state, note, reviewerID, now.UTC(), unhide, expectState, expectUpdatedAt)
	return int(n), err
}

// InsertReviewEvent 是人工判定落 review_events 的那一行（0020 §5.2）。
//
// 审计（audit_logs）与判定事件是两种东西，**都要**：
// audit_logs 回答「谁在什么时候动了什么」（后台操作流水），
// review_events 回答「这条主题被谁、因为什么、判过几次」—— 后者是判定历史，
// 每判一次一条（AI 那一侧早已在写，见 aireview/sql.go 的 sqlInsertEvent）；
// 少了它，后台设计稿的「谁判的、判过几次」只剩当前状态可读，改判历史全丢。
//
//   - trigger 恒为 'manual'：这条路径只可能是人在后台点的（值域 create|report|manual，0020）；
//   - source 恒为 'manual'：不可覆盖的判定来源（d7 §1 铁律）；
//   - verdict 是**状态名**（approve|reject|revision_requested），不是 API 的动作名 ——
//     打回的动作叫 request_revision 而库里的状态叫 revision_requested，service 负责换算；
//   - categories / model / latency_ms 是 AI 那侧才有的，留默认值。
func InsertReviewEvent(ctx context.Context, tx Querier, topicID int64, source, verdict, reason string,
	actorID *int64, now time.Time) error {
	return exec(ctx, tx,
		"INSERT INTO review_events (topic_id, trigger, source, verdict, reason, actor_id, created_at) "+
			"VALUES ($1, 'manual', $2, $3, $4, $5, $6)",
		topicID, source, verdict, clipReason(reason), actorID, now.UTC())
}

// SnapshotApprovedRevision 在「1 楼被批准发布」的那一刻把它的正文快照成「最后过审版本」
// （拍板 08 · L6；表在迁移 0028）。
//
// **先插后查**：正文此刻在库里就是被批准的那一份，所以直接从 posts 取。
// **NOT EXISTS** 而不是 ON CONFLICT：快照是幂等的，而且不能覆盖更早的那一份 ——
// 同一个 approved 版本被再批一次时，要留住的是**最早**成为「过审版本」的那次，
// 覆盖会让 approved_at 说谎（那是「这份内容什么时候被批准」的时间戳）。
// 一帖一份由 uq_topic_revisions_topic 兜底。
func SnapshotApprovedRevision(ctx context.Context, tx Querier, topicID, approverID int64, now time.Time) error {
	return exec(ctx, tx, snapshotRevisionSQL, topicID, approverID, now.UTC())
}

// HasApprovedRevision 回答「这一帖有没有过审版本」。service 用它决定**要不要**写快照，
// 而不是只比 review_state：一条 pending 的新帖被第一次批准时，它此前没有过审内容 ——
// 那种情况下写快照会把「还没审过的正文」记成历史（见 forum/review_queue.go 的说明）。
func (s *Store) HasApprovedRevision(ctx context.Context, q Querier, topicID int64) (bool, error) {
	var ok bool
	err := queryOneQ(ctx, q, "SELECT EXISTS (SELECT 1 FROM topic_revisions WHERE topic_id = $1)",
		[]any{topicID}, func(rows *sql.Rows) error { return rows.Scan(&ok) })
	return ok, err
}

// snapshotRevisionSQL 单独抽出来只为一件事：Go 的原始字符串里不能出现反引号，
// 而这条 SQL 用 sqlJoin 拼会变成一长串加号（读的人看不出 SQL 形状）。
const snapshotRevisionSQL = `INSERT INTO topic_revisions
  (topic_id, post_id, content_md, content_html, approved_by, approved_at, created_at, updated_at)
SELECT p.topic_id, p.id, p.content_md, p.content_html, $2, $3, $3, $3
  FROM posts p
 WHERE p.topic_id = $1 AND p.floor = 1
   AND NOT EXISTS (SELECT 1 FROM topic_revisions r WHERE r.topic_id = $1)`

// ApprovedRevision 读「最后过审版本」（没有就是 nil）：打回期间作者看到的那一份。
func (s *Store) ApprovedRevision(ctx context.Context, topicID int64) (*ApprovedRevisionRow, error) {
	var r ApprovedRevisionRow
	err := s.queryOne(ctx,
		"SELECT content_md, content_html, approved_at FROM topic_revisions WHERE topic_id = $1",
		[]any{topicID}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ContentMD, &r.ContentHTML, &r.ApprovedAt)
		})
	if err == ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ApprovedRevisionRow 是 topic_revisions 的一行（内容三列与 posts 逐字同名）。
type ApprovedRevisionRow struct {
	ContentMD   string
	ContentHTML string
	ApprovedAt  time.Time
}

// clipReason 是 reason 的 varchar(200) 硬上限（service 的 note 上限是 500，
// 两列宽度不同：写不下要在**这里**截，否则整条判定会因 22001 回滚）。
func clipReason(s string) string {
	const max = 200
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// InsertReviewAudit 是人工判定的审计行。AI 那一侧走 aireview/sql.go 的 sqlInsertAudit，
// 动作名不同（topic.review vs topic.ai_hide），表是同一张。
// target_id 存**对外 id**：audit_logs.target_id 是 varchar，按 0003_authz 的约定存 public_id。
func InsertReviewAudit(ctx context.Context, tx Querier, actorID int64, action, publicID string,
	detail []byte, now time.Time) error {
	return exec(ctx, tx,
		"INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at) "+
			"VALUES ($1, $2, 'topic', $3, $4::jsonb, $5)",
		actorID, action, publicID, string(detail), now.UTC())
}
