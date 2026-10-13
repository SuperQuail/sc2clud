package user

import (
	"context"
	"strings"

	ent "forum/internal/ent"
	"forum/internal/ent/predicate"
	"forum/internal/ent/user"
	"forum/internal/platform/apperr"
	"forum/internal/platform/idgen"
)

// Brief 是别的域要的最小用户画像（message / title / reward / report 各自 deps.go 的并集）。
// 跨域的类型转换在 app 层做：业务模块之间不互相 import（上线设计 §2 P1 决策 2）。
type Brief struct {
	ID            int64
	PublicID      string
	Handle        string
	Nickname      string
	Status        string
	AvatarHash    string
	AvatarSmall   string
	DefaultAvatar string
}

// BriefByID / BriefByHandle / BriefByPublicID 是本模块读侧对其它域的三个入口。
// 查不到统一返回 apperr.ErrNotFound：各域的 404 判定在 app 的适配器里换成各自的哨兵
// （message.ErrUserNotFound / title.ErrUserNotFound），本包不认识那些域。
func (s *Service) BriefByID(ctx context.Context, userID int64) (*Brief, error) {
	return s.brief(ctx, user.IDEQ(userID))
}

func (s *Service) BriefByHandle(ctx context.Context, handle string) (*Brief, error) {
	handle = strings.TrimSpace(handle)
	if handle == "" {
		return nil, apperr.ErrNotFound
	}
	// EqualFold 与 uq_users_username_lower 的表达式一致（拍板 §5.9 第 2 条）。
	return s.brief(ctx, user.UsernameEqualFold(handle))
}

func (s *Service) BriefByPublicID(ctx context.Context, publicID string) (*Brief, error) {
	id, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	return s.brief(ctx, user.PublicIDEQ(id))
}

func (s *Service) brief(ctx context.Context, where predicate.User) (*Brief, error) {
	u, err := s.db.User.Query().Where(where).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, apperr.ErrNotFound
		}
		return nil, err
	}
	return &Brief{
		ID: u.ID, PublicID: u.PublicID.String(), Handle: u.Username,
		Nickname: displayName(u.Nickname, u.Username),
		Status:   u.Status, AvatarHash: deref(u.AvatarHash), AvatarSmall: deref(u.AvatarSmallHash),
		DefaultAvatar: deref(u.DefaultAvatarHash),
	}, nil
}
