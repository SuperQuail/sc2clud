package notify

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	ent "forum/internal/ent"
	"forum/internal/notify/pgsql"
	"forum/internal/platform/db"
)

// CreateNotifyInput 是队列 payload 的反序列化形状，键与 payload 一一对应（d4 §1.1）。
// 类别不在 payload 里：它由任务类型决定，由各自的 Notify* 填进 CreateInput。
type CreateNotifyInput struct {
	ActorID int64  `json:"actor_id"`
	RefType string `json:"ref_type"`
	RefID   int64  `json:"ref_id"`
	TopicID int64  `json:"topic_id"`
	UserID  int64  `json:"user_id"` // 仅 mention 用（被提及者）
	// State / Text 是 notify:review 的**判定时快照**（forum 侧投任务时写进 payload）。
	// 为什么不能只现读 topics：拒绝之后紧接着放行时，两条任务都是后一个状态被读走，
	// 作者的「拒绝理由」一个字都送不到。空串 = 老 payload（或别的来源），退回现读。
	State string `json:"state"`
	Text  string `json:"text"`
}

// ParsePayload 解队列 payload（app/worker.go 注册处理函数时用）。
func ParsePayload(b []byte) (CreateNotifyInput, error) {
	var in CreateNotifyInput
	if err := json.Unmarshal(b, &in); err != nil {
		return in, fmt.Errorf("notify: parse payload: %w", err)
	}
	return in, nil
}

// NotifyReply 处理 notify:reply：收件人 = 主题作者 + 被回复楼层的作者（去重，d4 §5.1 ①）。
// 楼中楼只追一级（parent_id 只有一级），再往上不追。
func (s *Service) NotifyReply(ctx context.Context, in CreateNotifyInput) error {
	t, err := s.pg.ReplyTarget(ctx, in.RefID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // 楼层已删：没有可通知的对象，任务算完成
	}
	if err != nil {
		return err
	}
	recipients := []int64{t.TopicAuthorID}
	if t.ParentAuthorID != nil {
		recipients = append(recipients, *t.ParentAuthorID)
	}
	return s.deliver(ctx, KindReply, in, recipients, "/t/"+t.TopicPublicID, nil)
}

// NotifyMention 处理 notify:mention：只发给 payload 里的那个被提及者（d4 §5.1 ②）。
// 来源有两处：帖子正文（ref_type=post，1 楼也是 post）与 issue 评论（ref_type=comment）。
func (s *Service) NotifyMention(ctx context.Context, in CreateNotifyInput) error {
	if in.UserID == in.ActorID {
		return nil // 自己提自己不发
	}
	var topicPublicID string
	if in.RefType == RefPost {
		// 被回复的人又在这条正文里被 @：只发 reply 一条（d4 §5.1「reply 优先」）。
		// 判在实体上而不是「已存在 reply 行」，两个任务的先后顺序就不会影响结果。
		t, err := s.pg.ReplyTarget(ctx, in.RefID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if in.UserID == t.TopicAuthorID || (t.ParentAuthorID != nil && in.UserID == *t.ParentAuthorID) {
			return nil
		}
		topicPublicID = t.TopicPublicID
	} else {
		id, err := s.pg.TopicPublicID(ctx, in.TopicID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		topicPublicID = id
	}
	return s.deliver(ctx, KindMention, in, []int64{in.UserID}, "/t/"+topicPublicID, nil)
}

// NotifyLike 处理 notify:like：收件人是被赞对象的作者（帖子 / 主题 / issue 评论，d4 §5.1 ③）。
func (s *Service) NotifyLike(ctx context.Context, in CreateNotifyInput) error {
	var (
		t   pgsql.LikeTarget
		err error
	)
	switch in.RefType {
	case RefPost:
		t, err = s.pg.LikePostTarget(ctx, in.RefID)
	case RefTopic:
		t, err = s.pg.LikeTopicTarget(ctx, in.RefID)
	case RefComment:
		t, err = s.pg.LikeCommentTarget(ctx, in.RefID)
	default:
		// likes.target_type 还有 issue；本设计只钉死了 post / topic / comment 三个来源
		return fmt.Errorf("notify: notify:like 不认识的 ref_type %q", in.RefType)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.deliver(ctx, KindLike, in, []int64{t.AuthorID}, "/t/"+t.TopicPublicID, nil)
}

// NotifyReward 处理 notify:reward：收件人是收款人，金额与状态回查 donation_records（d4 §5.1 ④）。
func (s *Service) NotifyReward(ctx context.Context, in CreateNotifyInput) error {
	t, err := s.pg.RewardTarget(ctx, in.RefID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // 还没核验通过（或已撤回）：不发
	}
	if err != nil {
		return err
	}
	return s.deliver(ctx, KindReward, in, []int64{t.RecipientID}, "/u/"+t.RecipientUsername,
		map[string]any{"amount_cents": t.AmountCents})
}

// NotifyReview 处理 notify:review：收件人是主题作者。审核态与理由**优先用 payload 里的快照**，
// 只有老 payload（State 为空）才现读 topics（d4 §5.1 ⑤）。
//
// 为什么必须是快照：任务是至少一次投递、可能延迟消费。原来现读 topics 时，
// 「拒绝（带理由）→ 紧接着放行」这一串会把两条任务都读成后一个状态 ——
// 作者的拒绝理由一个字都送不到（M5，2026-10-14）。判定那一刻的事实只有 payload 里有。
// 触发者仍取 topics.reviewed_by（payload 里那个 actor_id 是 0）——审核人是谁只有那一列知道。
//
// 【与 d4 §9 自检 4 冲突】AI 判定（reviewed_by 为空）时这条通知的 actor 也是 NULL，
// 那条「非 system 通知必须有 actor」的自检需要给它豁免，见交接回报。
func (s *Service) NotifyReview(ctx context.Context, in CreateNotifyInput) error {
	t, err := s.pg.ReviewTarget(ctx, in.RefID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	state, text := t.State, t.Note
	if in.State != "" {
		state, text = in.State, in.Text
	}
	return s.createAll(ctx, []CreateInput{{
		UserID:  t.AuthorID,
		ActorID: t.ReviewedBy,
		Kind:    KindReview,
		RefType: RefTopic,
		RefID:   in.RefID,
		TopicID: in.RefID,
		Link:    "/t/" + t.TopicPublicID,
		Extra:   map[string]any{"state": state, "text": text},
	}})
}

// NotifySanction 处理 notify:sanction：收件人是被处罚的人（d4 §5.1 ⑥）。
func (s *Service) NotifySanction(ctx context.Context, in CreateNotifyInput) error {
	t, err := s.pg.SanctionTarget(ctx, in.RefID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	extra := map[string]any{"text": t.Reason}
	if t.Until != nil {
		extra["until"] = t.Until.UTC().Format(time.RFC3339)
	}
	return s.deliver(ctx, KindSanction, in, []int64{t.UserID}, "", extra)
}

// deliver 是「有明确收件人名单」的任务入口共用的收尾：去重、去掉自己触发的事件、加渲染字段。
func (s *Service) deliver(ctx context.Context, kind string, in CreateNotifyInput, recipients []int64,
	link string, extra map[string]any) error {
	ins := make([]CreateInput, 0, len(recipients))
	seen := make(map[int64]bool, len(recipients))
	for _, uid := range recipients {
		if uid == in.ActorID || seen[uid] {
			continue // 自己回复自己 / 自己赞自己 / 自己提自己：不发（d4 §5.1）
		}
		seen[uid] = true
		ins = append(ins, CreateInput{
			UserID:  uid,
			ActorID: in.ActorID,
			Kind:    kind,
			RefType: in.RefType,
			RefID:   in.RefID,
			TopicID: in.TopicID,
			Link:    link,
			Extra:   extra,
		})
	}
	return s.createAll(ctx, ins)
}

// createAll 做「发不发」的判定，然后在一个事务里写完全部收件人。
func (s *Service) createAll(ctx context.Context, ins []CreateInput) error {
	if len(ins) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(ins))
	for _, in := range ins {
		ids = append(ids, in.UserID)
	}
	active, err := s.pg.ActiveUsers(ctx, ids)
	if err != nil {
		return err
	}
	keep := make([]CreateInput, 0, len(ins))
	for _, in := range ins {
		if _, ok := active[in.UserID]; !ok {
			continue // 收件人不存在 / banned / deleted：不发（d4 §5.1）
		}
		ok, err := s.allowed(ctx, in)
		if err != nil {
			return err
		}
		if ok {
			keep = append(keep, in)
		}
	}
	if len(keep) == 0 {
		return nil
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		for _, in := range keep {
			if err := s.Create(ctx, tx, in); err != nil {
				return err
			}
		}
		return nil
	})
}

// allowed 是「这条通知要不要产生」的唯一判定点（d4 §4.5 + §5.1）：
// 静音命中 → 不产生任何行；通知设置关掉对应类别 → 不产生。
func (s *Service) allowed(ctx context.Context, in CreateInput) (bool, error) {
	muted, err := s.pg.Muted(ctx, in.UserID, in.Kind, RefKey(in.RefType, in.RefID))
	if err != nil {
		return false, err
	}
	if muted {
		return false, nil
	}
	set, err := s.settings.Get(ctx, in.UserID)
	if err != nil {
		return false, err
	}
	if !set.Alert {
		return false, nil // 「消息提醒」总开关
	}
	switch in.Kind {
	case KindReply:
		return set.ReplyScope != "none", nil
	case KindMention:
		return set.MentionScope != "none", nil
	case KindLike:
		return set.LikeAlert, nil
	}
	return true, nil
}
