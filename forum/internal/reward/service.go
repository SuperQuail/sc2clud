// Package reward 实现赞赏：收款码展示、申报、撤回、人工核验、统计与提示文案。
//
// 站点不经手资金（拍板 §6）：这里没有支付网关、回调、对账、余额，只有「用户自报 + 管理员人工核验」。
// 依据：完全重构/后端设计/d6-reward.md。
package reward

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	ent "forum/internal/ent"
	"forum/internal/ent/donationrecord"
	"forum/internal/ent/paymentchannel"
	"forum/internal/ent/predicate"
	"forum/internal/ent/userdonationsetting"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/idgen"

	"forum/internal/authz"
)

// Service 是赞赏模块的全部业务逻辑。actor 由 handler 显式传入（拍板 §5.3），不从 context 取。
type Service struct {
	db    *ent.Client
	q     Queue
	users UserLookup
	set   Settings
	audit Auditor
	clk   clock.Clock
	log   *slog.Logger
}

// NewService 的签名就是接线契约：db / queue / 用户查询 / 站点设置 / 审计 / 时钟 / 日志。
func NewService(db *ent.Client, q Queue, users UserLookup, set Settings, a Auditor, clk clock.Clock, log *slog.Logger) *Service {
	return &Service{db: db, q: q, users: users, set: set, audit: a, clk: clk, log: log}
}

// enabled 读站点开关。没有 site 实现时按开启处理：关站是显式动作，缺配置不该把功能锁死。
func (s *Service) enabled(ctx context.Context) bool {
	return s.set == nil || s.set.Setting(ctx, settingEnabled) != "off"
}

// requirePerm 是队列 / CLI 也会走到的兜底判定（不走路由也挡住）。
func requirePerm(actor *authz.Actor, perm string) error {
	if actor == nil || actor.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	if !actor.IsSuper && !actor.Perms.Has(perm) {
		return apperr.ErrForbidden
	}
	return nil
}

// writeAudit 是写审计的唯一入口：调用点全部在 WithTx 回调内，审计与业务行同事务。
func (s *Service) writeAudit(ctx context.Context, tx *ent.Tx, actorID int64, action, targetType, targetID string, detail map[string]any, ip string) error {
	id := actorID
	return s.audit.Write(ctx, tx, AuditEntry{
		ActorID:    &id,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		Detail:     detail,
		IP:         ip,
	})
}

// apperrCode 取业务错误码；不是 *apperr.Error 就返回 false（批量核验遇到它要整批回滚）。
func apperrCode(err error) (string, bool) {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		return ae.Code, true
	}
	return "", false
}

// isNotFound 收口 ent 的 NotFound 判定，避免每个调用点各写一次 errors.As。
func isNotFound(err error) bool { return ent.IsNotFound(err) }

// ---- 游标分页（拍板 §5.1：排序键永远带 id 兜底）----

func encodeCursor(ref time.Time, id int64) string {
	b, err := json.Marshal(cursor{T: ref.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor 解不出就是 400：伪造的游标不该被当成「第一页」静默吞掉。
func decodeCursor(s string) (*cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, errBadCursor
	}
	var c cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, errBadCursor
	}
	return &c, nil
}

var errBadCursor = apperr.ErrInvalidInput.WithFields(map[string]string{"cursor": "游标格式不正确"})

// lastCursor 取多出来的那一行做下一页游标。
func lastCursor(r *ent.DonationRecord) string { return encodeCursor(r.CreatedAt, r.ID) }

// before 是 (created_at, id) < (c.T, c.ID) 的行构造器比较，与索引列序逐字对齐。
func before(c *cursor) func(*ent.DonationRecordQuery) *ent.DonationRecordQuery {
	if c == nil {
		return func(q *ent.DonationRecordQuery) *ent.DonationRecordQuery { return q }
	}
	return func(q *ent.DonationRecordQuery) *ent.DonationRecordQuery {
		return q.Where(donationrecord.Or(
			donationrecord.CreatedAtLT(c.T),
			donationrecord.And(donationrecord.CreatedAtEQ(c.T), donationrecord.IDLT(c.ID)),
		))
	}
}

func limitOf(n int) int {
	switch {
	case n <= 0:
		return defaultLimit
	case n > maxLimit:
		return maxLimit
	default:
		return n
	}
}

func parsePublicID(s, field string) (uuid.UUID, error) {
	id, err := idgen.ParsePublicID(s)
	if err != nil {
		return uuid.Nil, apperr.ErrInvalidInput.WithFields(map[string]string{field: "格式不正确"})
	}
	return id, nil
}

// decode 是「空游标 = 第一页」的入口。
func (s *Service) decode(raw string) (*cursor, error) {
	if raw == "" {
		return nil, nil
	}
	return decodeCursor(raw)
}

// ---- 视图组装 ----

// userBriefs 批量取用户画像；同一个人在多行里出现只查一次。
func (s *Service) userBriefs(ctx context.Context, userIDs []int64) (map[int64]UserBrief, error) {
	out := make(map[int64]UserBrief, len(userIDs))
	for _, id := range userIDs {
		if _, ok := out[id]; ok {
			continue
		}
		b, err := s.users.Basic(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("读用户画像 %d: %w", id, err)
		}
		out[id] = UserBrief{Handle: b.Handle, Nickname: b.Nickname, Avatar: b.Avatar}
	}
	return out, nil
}

// publicRecipients 返回「授权展示自己收到的记录」的用户集合，只查传进来的那些 id。
// 展示与统计的口径都走这两个函数，避免两处各写一套判定（d6-reward §6.4）。
func (s *Service) publicRecipients(ctx context.Context, q *ent.UserDonationSettingQuery, userIDs []int64) (map[int64]bool, error) {
	return switchOn(ctx, q, userIDs, userdonationsetting.ShowChannelsEQ)
}

// publicDonors 返回「授权公开自己发出的记录」的用户集合。
func (s *Service) publicDonors(ctx context.Context, q *ent.UserDonationSettingQuery, userIDs []int64) (map[int64]bool, error) {
	return switchOn(ctx, q, userIDs, userdonationsetting.RecordsPublicEQ)
}

func switchOn(ctx context.Context, q *ent.UserDonationSettingQuery, userIDs []int64, on func(bool) predicate.UserDonationSetting) (map[int64]bool, error) {
	out := make(map[int64]bool, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	rows, err := q.Where(userdonationsetting.UserIDIn(userIDs...), on(true)).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读赞赏展示开关: %w", err)
	}
	for _, r := range rows {
		out[r.UserID] = true
	}
	return out, nil
}

// dedup 收集去重后的 id。
func dedup[T any](rows []T, f func(T) int64) []int64 {
	seen := make(map[int64]bool, len(rows))
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		id := f(r)
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// viewDonations 把 ent 行转成对外 DTO。只出 public_id 与昵称头像，内部 id 不出现在任何位置。
func (s *Service) viewDonations(ctx context.Context, rows []*ent.DonationRecord) ([]Donation, error) {
	if len(rows) == 0 {
		return []Donation{}, nil
	}
	userIDs := dedup(rows, func(r *ent.DonationRecord) int64 { return r.DonorID })
	userIDs = append(userIDs, dedup(rows, func(r *ent.DonationRecord) int64 { return r.RecipientID })...)
	for _, r := range rows {
		if r.VerifiedBy != nil {
			userIDs = append(userIDs, *r.VerifiedBy)
		}
	}
	briefs, err := s.userBriefs(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	channels, err := s.channelIDs(ctx, dedup(rows, func(r *ent.DonationRecord) int64 {
		if r.ChannelID == nil {
			return 0
		}
		return *r.ChannelID
	}))
	if err != nil {
		return nil, err
	}
	out := make([]Donation, 0, len(rows))
	for _, r := range rows {
		d := Donation{
			ID:          r.PublicID.String(),
			AmountCents: r.AmountCents,
			TxnID:       r.TxnID,
			State:       r.State,
			Note:        r.Note,
			Donor:       briefs[r.DonorID],
			Recipient:   briefs[r.RecipientID],
			VerifiedAt:  r.VerifiedAt,
			CreatedAt:   r.CreatedAt,
		}
		if r.ChannelID != nil {
			d.ChannelID = channels[*r.ChannelID]
		}
		if r.VerifiedBy != nil {
			b := briefs[*r.VerifiedBy]
			d.Verifier = &b
		}
		out = append(out, d)
	}
	return out, nil
}

// channelIDs 把内部的 payment_channels.id 还原成对外 id；0（未指定）与已删除的码都返回空串。
func (s *Service) channelIDs(ctx context.Context, rawIDs []int64) (map[int64]string, error) {
	out := make(map[int64]string, len(rawIDs))
	keep := make([]int64, 0, len(rawIDs))
	for _, id := range rawIDs {
		if id == 0 {
			continue
		}
		keep = append(keep, id)
	}
	if len(keep) == 0 {
		return out, nil
	}
	rows, err := s.db.PaymentChannel.Query().
		Where(paymentchannel.IDIn(keep...)).
		Select(paymentchannel.FieldID, paymentchannel.FieldPublicID).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读收款码对外 id: %w", err)
	}
	for _, r := range rows {
		out[r.ID] = r.PublicID.String()
	}
	return out, nil
}

// page 裁掉多取的那一条并算出 next_cursor。
func (s *Service) page(ctx context.Context, rows []*ent.DonationRecord, limit int) (*DonationPage, error) {
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = lastCursor(rows[len(rows)-1])
	}
	items, err := s.viewDonations(ctx, rows)
	if err != nil {
		return nil, err
	}
	return &DonationPage{Items: items, NextCursor: next}, nil
}
