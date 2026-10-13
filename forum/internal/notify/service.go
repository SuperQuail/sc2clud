package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/notification"
	"forum/internal/notify/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
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
}

func NewService(db *ent.Client, clk clock.Clock, pg *pgsql.Queries, settings NoticeSettings) *Service {
	return &Service{db: db, clk: clk, pg: pg, settings: settings}
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
	// payload 只放渲染这一条所需的最小形状，不放快照（d4 §1.1）
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
	// 系统通知没有「同一次事件」，不带 dedup_key（否则两条系统通知会互相顶掉）
	dedup := ""
	if in.Kind != KindSystem {
		dedup = DedupKey(in.Kind, in.RefType, in.RefID)
	}
	return pgsql.NewTx(tx).InsertNotification(ctx, publicID.String(), in.UserID, actorID,
		in.Kind, string(body), in.Link, dedup, s.clk.Now())
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
	rows, err := s.pg.ListNotifications(ctx, actor.UserID, at, cursorID, in.Kind, in.UnreadOnly, limit+1)
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

// Purge 分批硬删软删超过保留期的通知（d4 §5.5，给 cron 调）。
func (s *Service) Purge(ctx context.Context, before time.Time, limit int) (int, error) {
	return s.pg.Purge(ctx, before, limit)
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
