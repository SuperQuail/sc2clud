package follow

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"forum/internal/follow/pgsql"
	"forum/internal/platform/apperr"
)

// 与别域同一套分页上限（forum/appeal/report 都是 20/100）。
const (
	defaultLimit = 20
	maxLimit     = 100
)

// Service 只依赖 Store（一张表），没有 deps 接口、没有事件、没有队列：
// 关注不发通知（拍板 L5），所以这里没有「装配时要注入别人」的东西。
type Service struct{ store *pgsql.Store }

func NewService(store *pgsql.Store) *Service { return &Service{store: store} }

// ── 写：关注 / 取关（幂等，d4 §4.5 与 §7 的同一条口径）────────────────────
//
// 「重复关注」返回 200 + 同一份状态（不是 409）：「我想关注它」这件事已经成立，
// 409 只会让前端多一条要处理的分支。取关同理，重复取关也是 204。

// FollowUser 关注某人。followerID 是**当前登录用户**（actor），不能关注自己（400）。
func (s *Service) FollowUser(ctx context.Context, followerID int64, handle string) (*State, error) {
	target, err := s.resolveUser(ctx, handle)
	if err != nil {
		return nil, err
	}
	if target == followerID {
		return nil, apperr.Invalid(map[string]string{"handle": "不能关注自己"})
	}
	if _, err := s.store.FollowUser(ctx, followerID, target); err != nil {
		return nil, err
	}
	return s.userState(ctx, followerID, target, handle)
}

func (s *Service) UnfollowUser(ctx context.Context, followerID int64, handle string) (*State, error) {
	target, err := s.resolveUser(ctx, handle)
	if err != nil {
		return nil, err
	}
	if _, err := s.store.UnfollowUser(ctx, followerID, target); err != nil {
		return nil, err
	}
	return s.userState(ctx, followerID, target, handle)
}

// FollowBoard 关注分区。归档分区也能关注（归档只拦发帖）。
func (s *Service) FollowBoard(ctx context.Context, followerID int64, slug string) (*State, error) {
	target, err := s.resolveBoard(ctx, slug)
	if err != nil {
		return nil, err
	}
	if _, err := s.store.FollowBoard(ctx, followerID, target); err != nil {
		return nil, err
	}
	return s.boardState(ctx, followerID, target, slug)
}

func (s *Service) UnfollowBoard(ctx context.Context, followerID int64, slug string) (*State, error) {
	target, err := s.resolveBoard(ctx, slug)
	if err != nil {
		return nil, err
	}
	if _, err := s.store.UnfollowBoard(ctx, followerID, target); err != nil {
		return nil, err
	}
	return s.boardState(ctx, followerID, target, slug)
}

// ── 读：状态（同一份形状，所以「关注完」与「进页面时」前端读的是同一个字段）──

// UserState / BoardState 的 followerID 可以是 0：**未登录也要能读关注数**
// （分区页的「成员」格是给所有人看的，游客那一格不该是 0）。0 时 following 恒 false。

func (s *Service) UserState(ctx context.Context, followerID int64, handle string) (*State, error) {
	target, err := s.resolveUser(ctx, handle)
	if err != nil {
		return nil, err
	}
	return s.userState(ctx, followerID, target, handle)
}

func (s *Service) BoardState(ctx context.Context, followerID int64, slug string) (*State, error) {
	target, err := s.resolveBoard(ctx, slug)
	if err != nil {
		return nil, err
	}
	return s.boardState(ctx, followerID, target, slug)
}

func (s *Service) userState(ctx context.Context, followerID, target int64, handle string) (*State, error) {
	n, err := s.store.CountUserFollowers(ctx, target)
	if err != nil {
		return nil, err
	}
	following := false
	if followerID != 0 {
		if following, err = s.store.FollowingUser(ctx, followerID, target); err != nil {
			return nil, err
		}
	}
	return &State{Target: TargetUser, Handle: handle, Following: following, FollowerCount: n}, nil
}

func (s *Service) boardState(ctx context.Context, followerID, target int64, slug string) (*State, error) {
	n, err := s.store.CountBoardFollowers(ctx, target)
	if err != nil {
		return nil, err
	}
	following := false
	if followerID != 0 {
		if following, err = s.store.FollowingBoard(ctx, followerID, target); err != nil {
			return nil, err
		}
	}
	return &State{Target: TargetBoard, Slug: slug, Following: following, FollowerCount: n}, nil
}

// ── 读：列表 ────────────────────────────────────────────────────────────
//
// 三条：某人 / 某分区的关注者（**公开**，游客可读），以及「我关注的」（要登录，本人语义）。

// Followers 是某人 / 某分区的关注者（GET /users/{handle}/followers、GET /boards/{slug}/followers）。
func (s *Service) Followers(ctx context.Context, target, key string, in ListInput) (*UserPage, error) {
	at, cursorID, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	// 两种目标的「关注者」是同一张表的两列，差别只在解 key 与取哪一侧的行。
	// 用一个闭包把差异收在一处，返回的仍是同一个 UserPage（关注者永远是用户）。
	var load func() ([]pgsql.UserRow, error)
	switch target {
	case TargetUser:
		load = func() ([]pgsql.UserRow, error) {
			id, err := s.resolveUser(ctx, key)
			if err != nil {
				return nil, err
			}
			return s.store.ListUserFollowers(ctx, id, at, cursorID, limit+1)
		}
	case TargetBoard:
		load = func() ([]pgsql.UserRow, error) {
			id, err := s.resolveBoard(ctx, key)
			if err != nil {
				return nil, err
			}
			// 分区的关注者也是用户：Store 直接回 UserRow，分页与 DTO 组装就只有一份实现。
			return s.store.ListBoardFollowers(ctx, id, at, cursorID, limit+1)
		}
	default:
		// 值域只有一个来源（handler 的两个方法），走到这里说明代码 bug，不是用户输入
		return nil, apperr.ErrInternal
	}
	rows, err := load()
	if err != nil {
		return nil, err
	}
	items, next := pageUsers(rows, limit)
	return &UserPage{Items: items, NextCursor: next}, nil
}

// MyBoards 是「我关注的分区」（GET /me/following/boards）。
func (s *Service) MyBoards(ctx context.Context, followerID int64, in ListInput) (*BoardPage, error) {
	at, cursorID, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	rows, err := s.store.ListFollowingBoards(ctx, followerID, at, cursorID, limit+1)
	if err != nil {
		return nil, err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = encodeCursor(rows[limit-1].FollowedAt, rows[limit-1].FollowID)
	}
	items := make([]BoardItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, BoardItem{
			Slug: r.Slug, Name: r.Name, Description: r.Description,
			CoverHash: deref(r.CoverHash), FollowedAt: r.FollowedAt.UTC(),
		})
	}
	return &BoardPage{Items: items, NextCursor: next}, nil
}

// MyUsers 是「我关注的人」（GET /me/following/users）。
func (s *Service) MyUsers(ctx context.Context, followerID int64, in ListInput) (*UserPage, error) {
	at, cursorID, err := decodeCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOf(in.Limit)
	rows, err := s.store.ListFollowingUsers(ctx, followerID, at, cursorID, limit+1)
	if err != nil {
		return nil, err
	}
	items, next := pageUsers(rows, limit)
	return &UserPage{Items: items, NextCursor: next}, nil
}

// ── 内部工具 ────────────────────────────────────────────────────────────

func (s *Service) resolveUser(ctx context.Context, handle string) (int64, error) {
	handle = strings.TrimSpace(handle)
	if handle == "" {
		return 0, apperr.ErrNotFound
	}
	id, err := s.store.UserIDByHandle(ctx, handle)
	if pgsql.IsNoRows(err) {
		return 0, apperr.ErrNotFound
	}
	return id, err
}

func (s *Service) resolveBoard(ctx context.Context, slug string) (int64, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return 0, apperr.ErrNotFound
	}
	id, err := s.store.BoardIDBySlug(ctx, slug)
	if pgsql.IsNoRows(err) {
		return 0, apperr.ErrNotFound
	}
	return id, err
}

// pageUsers 裁掉多取的那一条并算游标（与 appeal 的 page 同一套）。
// **游标取 FollowID（follows.id），不是被关注者的 id**：排序键是 (f.created_at, f.id)，
// 游标必须与排序键同源，否则比较的永远是两个不同的东西（这条踩过一次，见 pgsql.UserRow 的注释）。
func pageUsers(rows []pgsql.UserRow, limit int) ([]UserItem, string) {
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next = encodeCursor(last.FollowedAt, last.FollowID)
	}
	items := make([]UserItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, UserItem{
			PublicID: r.PublicID, Handle: r.Handle, Nickname: r.Nickname,
			AvatarHash: r.Avatar, AvatarSmall: r.AvatarSmall, FollowedAt: r.FollowedAt.UTC(),
		})
	}
	return items, next
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
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

// ---- 游标（与 appeal/report 同一套：排序键永远带 id 兜底）----

type cursor struct {
	T  time.Time `json:"t"`
	ID int64     `json:"id"`
}

func encodeCursor(t time.Time, id int64) string {
	b, err := json.Marshal(cursor{T: t.UTC(), ID: id})
	if err != nil {
		// 只含一个时间与一个整数，序列化不可能失败
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (*time.Time, int64, error) {
	if s == "" {
		return nil, 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, 0, badCursor()
	}
	var c cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, 0, badCursor()
	}
	t := c.T.UTC()
	return &t, c.ID, nil
}

func badCursor() error {
	return apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
}
