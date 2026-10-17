package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/notification"
	"forum/internal/notify/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"
)

const (
	defaultLimit = 20
	maxLimit     = 100
)

type Service struct {
	db       *ent.Client
	clk      clock.Clock
	pg       *pgsql.Queries
	settings NoticeSettings
	// publish 是「这个人的通知变了」的进程内信号（L11 的 SSE 用），由 handler 装配时赋上
	// （NewHandler 里 svc.publish = hub.Publish）。为空时什么都不发生 —— Service 本身无状态，
	// 而广播是 handler 的状态，所以这条线只能这样接。
	// 它**不阻塞也不保证送达**：前端把它当「可能变了，去重取一次」用（stream.go 文件头有完整取舍）。
	publish func(userID int64)
}

func NewService(db *ent.Client, clk clock.Clock, pg *pgsql.Queries, settings NoticeSettings) *Service {
	return &Service{db: db, clk: clk, pg: pg, settings: settings}
}

// notifyChanged 是写完之后唯一的发出点。三处调用：Create（业务方事务里写的）、
// NotifySystem（系统通知）、Delete（自己删掉一条）。
// **MarkRead 不发**：那是用户自己按的「已读」，前端那一次请求的响应里就知道结果了。
func (s *Service) notifyChanged(userID int64) {
	if s.publish != nil {
		s.publish(userID)
	}
}

// Create 在调用方的事务里写一条通知，按 (user_id, dedup_key) 幂等（d4 §4.4）。
// 「要不要发」的判定在任务入口（d4 §5.1），这里只负责写。
func (s *Service) Create(ctx context.Context, tx *ent.Tx, in CreateInput) error {
	publicID, err := idgen.NewPublicID()
	if err != nil {
		return err
	}
	var actorID *int64
	if in.ActorID != 0 {
		actorID = &in.ActorID
	}
	// payload 只放渲染这一条所需的最小形状（d4 §1.1）。
	// 例外是审核结果：它的 state/text 是**判定那一刻的快照**（Extra 里带过来），
	// 因为消费时现读 topics 会把前后两次判定读成同一个状态（M5）。
	payload := map[string]any{"ref_type": in.RefType, "ref_id": in.RefID}
	if in.TopicID != 0 {
		payload["topic_id"] = in.TopicID
	}
	if in.Text != "" {
		payload["text"] = in.Text
	}
	for k, v := range in.Extra {
		payload[k] = v
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("notify: marshal payload: %w", err)
	}
	// 系统通知没有「同一次事件」，不带 dedup_key（否则两条系统通知会互相顶掉）。
	// 审核结果同理**不带**：改判（拒绝→放行）是两次不同的事实，带着快照来就必须两条都发 ——
	// 去重键是 review:topic:<id>，(user_id, dedup_key) 会把第二条吃掉，作者只会看到先发生的那一次
	// （实测：reject 后紧接着 approve，作者收到 1 条「未通过」而帖子其实是 approved）。
	// 队列任务那边也为这个目的不设 UniqueKey（forum/review_queue.go）。
	dedup := ""
	if in.Kind != KindSystem && in.Extra["state"] == nil {
		dedup = DedupKey(in.Kind, in.RefType, in.RefID)
	}
	if err := pgsql.NewTx(tx).InsertNotification(ctx, publicID.String(), in.UserID, actorID,
		in.Kind, string(body), in.Link, dedup, s.clk.Now()); err != nil {
		return err
	}
	s.notifyChanged(in.UserID)
	return nil
}

// NotifySystem 是**业务方直接发一条站内通知**的入口（不问队列）。
//
// 为什么需要它：队列任务类型只有 d4 §5.1 的那六种（reply/mention/like/reward/review/sanction），
// 系统通知没有对应的任务类型，也没有触发它的领域事件 —— 它是「有人在某个流程里要告诉用户一件事」，
// 例如申诉的答复（appeal 域的 C4）。自己没有表、也不想为一条通知加一个任务类型时走这里。
//
// 三件事与任务入口一致：写前置判定（静音 + 消息设置，复用 allowed）、自己开事务、
// kind 固定 system（**调用方不许自选**：kind 的分档决定它在通知中心出现在哪一档）。
func (s *Service) NotifySystem(ctx context.Context, userID int64, text, link string) error {
	if userID == 0 {
		return nil // 没有收件人（未登录提交的申诉走到这里）：不是错误，本来就没有人收
	}
	body := strings.TrimSpace(text)
	if body == "" {
		return nil
	}
	in := CreateInput{UserID: userID, Kind: KindSystem, RefType: RefSystem, Link: link, Text: body}
	ok, err := s.allowed(ctx, in)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	// Create 自己会发信号，这里不重复发
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error { return s.Create(ctx, tx, in) })
}

// List 走 idx_notifications_inbox 的游标分页（d4 §4.1）。
func (s *Service) List(ctx context.Context, actor *authz.Actor, in ListInput) (*ListResult, error) {
	limit := clampLimit(in.Limit)
	var at *time.Time
	var cursorID int64
	if in.Cursor != "" {
		k, id, err := decodeCursor(in.Cursor)
		if err != nil {
			return nil, err
		}
		at, cursorID = &k, id
	}
	// 多取一行就知道还有没有下一页，省一次 COUNT
	kinds, err := parseListKinds(in.Kind)
	if err != nil {
		return nil, err
	}
	rows, err := s.pg.ListNotifications(ctx, actor.UserID, at, cursorID, kinds, in.UnreadOnly, limit+1)
	if err != nil {
		return nil, err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	items := make([]NotificationDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, toDTO(r))
	}
	return &ListResult{Items: items, NextCursor: next}, nil
}

// UnreadCount 走 idx_notifications_unread（d4 §4.2）。
func (s *Service) UnreadCount(ctx context.Context, actor *authz.Actor) (int, error) {
	return s.pg.UnreadCount(ctx, actor.UserID)
}

// MarkRead 返回本次新标记了几条；并发重放第二次是 0（d4 §4.3）。
func (s *Service) MarkRead(ctx context.Context, actor *authz.Actor, in MarkReadInput) (int, error) {
	if !in.All && len(in.PublicIDs) == 0 {
		return 0, apperr.Invalid(map[string]string{"ids": "不能为空"})
	}
	ids := make([]string, 0, len(in.PublicIDs))
	for _, raw := range in.PublicIDs {
		id, err := idgen.ParsePublicID(raw)
		if err != nil {
			return 0, apperr.Invalid(map[string]string{"ids": "格式不正确"})
		}
		ids = append(ids, id.String())
	}
	return s.pg.MarkRead(ctx, actor.UserID, s.clk.Now(), in.All, ids)
}

// Delete 是软删（只对自己隐藏）。别人的通知与不存在的通知返回同一个 404，避免枚举（d4 §7）。
func (s *Service) Delete(ctx context.Context, actor *authz.Actor, publicID string) error {
	id, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return apperr.ErrNotFound
	}
	now := s.clk.Now()
	n, err := s.db.Notification.Update().
		Where(notification.PublicIDEQ(id), notification.UserIDEQ(actor.UserID)).
		SetNillableDeletedAt(&now).
		Save(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		return apperr.ErrNotFound
	}
	s.notifyChanged(actor.UserID)
	return nil
}

// SetMute 是「不再通知」：整类或某条内容。重复设置幂等（d4 §4.5）。
func (s *Service) SetMute(ctx context.Context, actor *authz.Actor, in MuteInput) error {
	kind, targetKey, err := muteKey(in)
	if err != nil {
		return err
	}
	return s.pg.SetMute(ctx, actor.UserID, kind, targetKey, s.clk.Now())
}

// UnsetMute 取消静音。取消不存在的静音也是 204（d4 §7）。
func (s *Service) UnsetMute(ctx context.Context, actor *authz.Actor, in MuteInput) error {
	kind, targetKey, err := muteKey(in)
	if err != nil {
		return err
	}
	return s.pg.UnsetMute(ctx, actor.UserID, kind, targetKey)
}

// Settings 读自己的消息设置（GET /notifications/settings）。
// 表里没有这一行时返回列默认值 —— 前端因此拿到的一定是四个可用值，不需要「没设置过」这一态。
func (s *Service) Settings(ctx context.Context, actor *authz.Actor) (*NoticeSetting, error) {
	return s.settings.Get(ctx, actor.UserID)
}

// UpdateSettings 全量保存消息设置：四个字段一起给，没有「只改一个」的半更新语义
// （表就四列，全量写最省事，也不会出现「没传的字段被清成零值」这种歧义）。
// 返回值从库里重读，回执与下次 GET 一定是同一份。
func (s *Service) UpdateSettings(ctx context.Context, actor *authz.Actor, in NoticeSetting) (*NoticeSetting, error) {
	fields := map[string]string{}
	if !noticeScopes[in.ReplyScope] {
		fields["reply_scope"] = "只能是 all / none"
	}
	if !noticeScopes[in.MentionScope] {
		fields["mention_scope"] = "只能是 all / none"
	}
	if len(fields) > 0 {
		return nil, apperr.Invalid(fields)
	}
	if err := s.settings.Set(ctx, actor.UserID, in, s.clk.Now()); err != nil {
		return nil, err
	}
	return s.settings.Get(ctx, actor.UserID)
}

// 值域与 ck_user_notice_settings_reply_scope / _mention_scope 逐字一致。
// 没有 "followed"：拍板 §8.3 —— 本产品没有「关注用户」，0018 把它从值域里删了。
var noticeScopes = map[string]bool{"all": true, "none": true}

// Purge 分批硬删软删超过保留期的通知（d4 §5.5，给 cron 调）。
func (s *Service) Purge(ctx context.Context, before time.Time, limit int) (int, error) {
	return s.pg.Purge(ctx, before, limit)
}

// parseListKinds 把 ?kind=reply,mention 拆成数组并校值域。空串 = 全部（不限）。
// 值域与 kinds.go 的 Kind* 逐字一致；**不含 KindLink** —— 它是静音用的值，不是通知类别。
func parseListKinds(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		// **空切片，不是 nil**：这个值直接进 listSQL 的 $4::text[]，而无类型 nil 会被
		// pgx 当作 NULL 发出去 —— cardinality(NULL) 与 'x' = ANY(NULL) 都是 NULL，
		// 于是 "cardinality($4)=0 OR type = ANY($4)" 恒不成立，**列表整页空**
		// （2026-10-14 实测：25 条一条都拿不到）。语义上「不限类别」就是空集合。
		return []string{}, nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !noticeListKinds[p] {
			return nil, apperr.Invalid(map[string]string{"kind": "不支持的类别：" + p})
		}
		out = append(out, p)
	}
	return out, nil
}

var noticeListKinds = map[string]bool{
	KindReply: true, KindMention: true, KindLike: true, KindReward: true,
	KindReview: true, KindSanction: true, KindSystem: true,
}

func clampLimit(n int) int {
	if n <= 0 {
		return defaultLimit
	}
	if n > maxLimit {
		return maxLimit
	}
	return n
}

// muteKey 把两义的一行折成 (type, target_key)，并做 HTTP 入参校验（信任边界）。
func muteKey(in MuteInput) (string, string, error) {
	if !muteKinds[in.Type] {
		return "", "", apperr.Invalid(map[string]string{"type": "不支持的类别"})
	}
	if in.Type != KindLink {
		if in.RefType != "" || in.RefID != 0 {
			return "", "", apperr.Invalid(map[string]string{"type": "整类静音不带 ref_type/ref_id"})
		}
		return in.Type, "", nil
	}
	if !muteRefTypes[in.RefType] || in.RefID <= 0 {
		return "", "", apperr.Invalid(map[string]string{"ref_id": "按内容静音必须带 ref_type 与 ref_id"})
	}
	return KindLink, RefKey(in.RefType, in.RefID), nil
}

// 值域与 ck_notification_mutes_type / ck_notification_mutes_key 逐字一致。
var muteKinds = map[string]bool{
	KindReply: true, KindMention: true, KindLike: true, KindReward: true,
	KindReview: true, KindSanction: true, KindSystem: true, KindLink: true,
}

var muteRefTypes = map[string]bool{
	RefPost: true, RefTopic: true, RefComment: true, RefIssue: true,
	RefDonation: true, RefSanction: true, RefSystem: true,
}

func toDTO(r pgsql.NotificationRow) NotificationDTO {
	// payload 是 jsonb 列，内容由本包写入，一定是合法 JSON 对象
	payload := map[string]any{}
	_ = json.Unmarshal([]byte(r.Payload), &payload)
	d := NotificationDTO{
		ID:        r.PublicID,
		Kind:      r.Kind,
		Payload:   payload,
		Link:      r.Link,
		ReadAt:    r.ReadAt,
		CreatedAt: r.CreatedAt.UTC(),
	}
	if r.ActorUsername != nil {
		d.Actor = &UserBrief{
			Handle:      *r.ActorUsername,
			Nickname:    deref(r.ActorNickname),
			Avatar:      imgURL(r.ActorAvatar),
			AvatarSmall: imgURL(r.ActorAvatarSmall),
		}
	}
	return d
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// imgURL 是头像的唯一拼法：前端只拿 /img/<hash>，不做拼接（d5 §1.4）。空 hash = 没有头像。
func imgURL(hash *string) string {
	if hash == nil || *hash == "" {
		return ""
	}
	return "/img/" + *hash
}
