package message

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/message"
	"forum/internal/message/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/idgen"
)

const (
	defaultLimit = 20
	maxLimit     = 100
	maxBodyRunes = 2000 // varchar(2000) 是按字符算的
)

type Service struct {
	db     *ent.Client
	clk    clock.Clock
	pg     *pgsql.Queries
	users  UserLookup
	blocks BlockReader
}

func NewService(db *ent.Client, clk clock.Clock, pg *pgsql.Queries, users UserLookup, blocks BlockReader) *Service {
	return &Service{db: db, clk: clk, pg: pg, users: users, blocks: blocks}
}

// ListConversations：一次往返拿到「对方 + 最后一条 + 未读数」（d4 §4.6）。
func (s *Service) ListConversations(ctx context.Context, actor *authz.Actor, in PageInput) (*ConversationPage, error) {
	limit := clampLimit(in.Limit)
	var before int64
	if in.Cursor != "" {
		id, err := decodeCursor(in.Cursor)
		if err != nil {
			return nil, err
		}
		before = id
	}
	rows, err := s.pg.ListConversations(ctx, actor.UserID, before, limit+1)
	if err != nil {
		return nil, err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = encodeCursor(rows[limit-1].LastID)
	}
	items := make([]ConversationDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, ConversationDTO{
			Peer: UserBrief{
				ID:          r.PeerID,
				Handle:      r.PeerUsername,
				Nickname:    r.PeerNickname,
				Avatar:      imgURL(r.PeerAvatar),
				AvatarSmall: imgURL(r.PeerAvatarSmall),
			},
			UnreadCount: r.UnreadCount,
			Last: MessageDTO{
				ID:        r.LastPublicID,
				Body:      r.LastBody,
				Mine:      r.LastSenderID == actor.UserID,
				Read:      r.LastReadAt != nil,
				CreatedAt: r.LastCreatedAt.UTC(),
			},
		})
	}
	return &ConversationPage{Items: items, NextCursor: next}, nil
}

// ListThread：我删掉的不返回；对方删掉的不影响我（d4 §5.2）。
func (s *Service) ListThread(ctx context.Context, actor *authz.Actor, in ThreadInput) (*ThreadPage, error) {
	peer, err := s.peer(ctx, in.PeerHandle)
	if err != nil {
		return nil, err
	}
	limit := clampLimit(in.Limit)
	var before int64
	if in.Cursor != "" {
		id, err := decodeCursor(in.Cursor)
		if err != nil {
			return nil, err
		}
		before = id
	}
	rows, err := s.pg.ListThread(ctx, actor.UserID, peer.ID, actor.UserID < peer.ID, before, limit+1)
	if err != nil {
		return nil, err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = encodeCursor(rows[limit-1].ID)
	}
	items := make([]MessageDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, MessageDTO{
			ID:        r.PublicID,
			Body:      r.Body,
			Mine:      r.SenderID == actor.UserID,
			Read:      r.ReadAt != nil,
			CreatedAt: r.CreatedAt.UTC(),
		})
	}
	return &ThreadPage{Peer: *peer, Items: items, NextCursor: next}, nil
}

// Send 的判定顺序见 d4 §5.2（先做便宜的）。
func (s *Service) Send(ctx context.Context, actor *authz.Actor, in SendInput) (*MessageDTO, error) {
	peer, err := s.peer(ctx, in.PeerHandle)
	if err != nil {
		return nil, err
	}
	if peer.ID == actor.UserID {
		return nil, apperr.Invalid(map[string]string{"peer": "不能给自己发私信"})
	}
	aBlockedB, bBlockedA, err := s.blocks.BlockedBetween(ctx, actor.UserID, peer.ID)
	if err != nil {
		return nil, err
	}
	if aBlockedB || bBlockedA {
		return nil, errBlocked
	}
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return nil, apperr.Invalid(map[string]string{"body": "不能为空"})
	}
	if utf8.RuneCountInString(body) > maxBodyRunes {
		return nil, apperr.Invalid(map[string]string{"body": "不能超过 2000 字"})
	}
	publicID, err := idgen.NewPublicID()
	if err != nil {
		return nil, err
	}
	id, at, err := s.pg.InsertMessage(ctx, publicID.String(), actor.UserID, peer.ID, body, s.clk.Now())
	if err != nil {
		return nil, err
	}
	return &MessageDTO{ID: id, Body: body, Mine: true, Read: false, CreatedAt: at.UTC()}, nil
}

// MarkThreadRead 返回本次标了几条（对方发的未读）；并发重放第二次是 0（d4 §4.11）。
func (s *Service) MarkThreadRead(ctx context.Context, actor *authz.Actor, peerHandle string) (int, error) {
	peer, err := s.peer(ctx, peerHandle)
	if err != nil {
		return 0, err
	}
	return s.pg.MarkThreadRead(ctx, actor.UserID, peer.ID, actor.UserID < peer.ID, s.clk.Now())
}

// DeleteMessage 是「各自删除」：只置我这一侧的标记，对方照常看得见（d4 §5.2）。
// 不在我参与的会话里 → 404（与「不存在」同一个响应，避免枚举）。
func (s *Service) DeleteMessage(ctx context.Context, actor *authz.Actor, publicID string) error {
	id, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return apperr.ErrNotFound
	}
	m, err := s.db.Message.Query().Where(message.PublicIDEQ(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}
	if m.LowID != actor.UserID && m.HighID != actor.UserID {
		return apperr.ErrNotFound
	}
	upd := s.db.Message.UpdateOneID(m.ID)
	if actor.UserID == m.LowID {
		upd = upd.SetDeletedByLow(true)
	} else {
		upd = upd.SetDeletedByHigh(true)
	}
	return upd.Exec(ctx)
}

// UnreadTotal 是顶栏角标（d4 §4.8）：两条 index-only count，Go 侧相加。
func (s *Service) UnreadTotal(ctx context.Context, actor *authz.Actor) (int, error) {
	return s.pg.UnreadTotal(ctx, actor.UserID)
}

// Purge 分批硬删「双方都删且过期」的行（d4 §5.5，给 cron 调）。
func (s *Service) Purge(ctx context.Context, before time.Time, limit int) (int, error) {
	return s.pg.Purge(ctx, before, limit)
}

// peer 把 handle 解析成收件人；查不到 → 404。
func (s *Service) peer(ctx context.Context, handle string) (*UserBrief, error) {
	b, err := s.users.ByUsername(ctx, handle)
	if errors.Is(err, ErrUserNotFound) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return b, nil
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

// imgURL 是头像的唯一拼法：前端只拿 /img/<hash>（d5 §1.4）。空 hash = 没有头像。
func imgURL(hash *string) string {
	if hash == nil || *hash == "" {
		return ""
	}
	return "/img/" + *hash
}
