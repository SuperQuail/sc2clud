package app

import (
	"context"
	"errors"
	"html"

	"github.com/gin-gonic/gin"

	"forum/internal/auth"
	"forum/internal/authz"
	"forum/internal/ent"
	forumpgsql "forum/internal/forum/pgsql"
	"forum/internal/message"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	"forum/internal/platform/markdown"
	"forum/internal/platform/queue"
	"forum/internal/platform/search"
	"forum/internal/report"
	"forum/internal/reward"
	"forum/internal/title"
	"forum/internal/user"
)

// 本文件是跨域适配器的唯一落点（上线设计 §2 P1 决策 2）：
// 各域 deps.go 里的小接口在这里用别的域的实现填上，业务模块之间不互相 import。

// ── 队列 ──────────────────────────────────────────────────────────

// entQueue 把 platform/queue 收窄成 forum / reward deps.go 要的形状：
// 它们的 EnqueueTx 参数是 *ent.Tx，而 pgqueue 收的是 queue.TxExecutor（Go 的接口不协变，
// 方法签名必须逐字相同），所以这里转一层。
type entQueue struct{ q queue.Queue }

func (e entQueue) EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error {
	return e.q.EnqueueTx(ctx, tx, t)
}

// actorOf 是 forum 的 ActorFunc 形状（*authz.Actor，不带 bool）：游客是 nil，
// 「谁是游客」由 forum 自己按 nil 处理（它不引入第二个哨兵）。
func actorOf(c *gin.Context) *authz.Actor {
	actor, _ := auth.FromGin(c)
	return actor
}

// ── 渲染 ─────────────────────────────────────────────────────────

// mdRenderer 是 forum.Deps.Renderer 的实现（platform/markdown）。
// plain 与 html 必须同源（d3 §9.4）：plain 从**同一份 html** 提，不重新渲染一次 markdown。
type mdRenderer struct{}

func (mdRenderer) Render(md string) (string, string) {
	out, err := markdown.Render(md, nil)
	if err != nil {
		// 接口没有 error 位，而「渲染失败」不能降级成「把原文当 HTML 发出去」（那是 XSS）。
		// 转义后当纯文本发出去：用户看到的是自己的原文，正文不丢。
		return "<p>" + html.EscapeString(md) + "</p>", md
	}
	return out, search.PlainText(out)
}

// ── 用户画像 ──────────────────────────────────────────────────────

// 四个域各自要的用户画像只差返回类型（字段名都一样），查询只有 user.Service 一份。
// 查不到时把 apperr.ErrNotFound 换成消费方的哨兵：那是它们 404 判定的依据。

func (m *Modules) avatarOf(ctx context.Context, b *user.Brief) (string, string) {
	return m.Media.Avatar(ctx, b.ID, b.AvatarHash, b.AvatarSmall, b.DefaultAvatar)
}

// msgUsers 实现 message.UserLookup。
type msgUsers struct{ m *Modules }

func (a msgUsers) ByUsername(ctx context.Context, username string) (*message.UserBrief, error) {
	b, err := a.m.User.BriefByHandle(ctx, username)
	if err != nil {
		if errors.Is(err, apperr.ErrNotFound) {
			return nil, message.ErrUserNotFound
		}
		return nil, err
	}
	avatar, small := a.m.avatarOf(ctx, b)
	return &message.UserBrief{
		ID: b.ID, Handle: b.Handle, Nickname: b.Nickname,
		Avatar: avatar, AvatarSmall: small,
	}, nil
}

// titleUsers 实现 title.UserLookup（handler 用它把 handle / public_id 换成内部 id）。
type titleUsers struct{ m *Modules }

func (a titleUsers) ByUsername(ctx context.Context, username string) (*title.UserBrief, error) {
	b, err := a.m.User.BriefByHandle(ctx, username)
	if err != nil {
		if errors.Is(err, apperr.ErrNotFound) {
			return nil, title.ErrUserNotFound
		}
		return nil, err
	}
	return &title.UserBrief{ID: b.ID, Handle: b.Handle, Nickname: b.Nickname}, nil
}

func (a titleUsers) ByPublicID(ctx context.Context, publicID string) (*title.UserBrief, error) {
	b, err := a.m.User.BriefByPublicID(ctx, publicID)
	if err != nil {
		if errors.Is(err, apperr.ErrNotFound) {
			return nil, title.ErrUserNotFound
		}
		return nil, err
	}
	return &title.UserBrief{ID: b.ID, Handle: b.Handle, Nickname: b.Nickname}, nil
}

// rewardUsers 实现 reward.UserLookup。
type rewardUsers struct{ m *Modules }

func (a rewardUsers) IDByHandle(ctx context.Context, handle string) (int64, error) {
	b, err := a.m.User.BriefByHandle(ctx, handle)
	if err != nil {
		return 0, err
	}
	return b.ID, nil
}

func (a rewardUsers) Basic(ctx context.Context, userID int64) (reward.UserBasic, error) {
	b, err := a.m.User.BriefByID(ctx, userID)
	if err != nil {
		return reward.UserBasic{}, err
	}
	avatar, _ := a.m.avatarOf(ctx, b)
	return reward.UserBasic{
		PublicID: b.PublicID, Handle: b.Handle, Nickname: b.Nickname,
		Avatar: avatar, Status: b.Status,
	}, nil
}

// reportUsers 实现 report.UserLookup。
type reportUsers struct{ m *Modules }

func (a reportUsers) Basic(ctx context.Context, userID int64) (report.UserBrief, error) {
	b, err := a.m.User.BriefByID(ctx, userID)
	if err != nil {
		return report.UserBrief{}, err
	}
	avatar, _ := a.m.avatarOf(ctx, b)
	return report.UserBrief{
		PublicID: b.PublicID, Handle: b.Handle, Nickname: b.Nickname, Avatar: avatar,
	}, nil
}

// ── 举报目标 ──────────────────────────────────────────────────────

// reportTargets 实现 report.TargetResolver：每种 target 由**拥有那张表的域**解析
// （topic / post 在 forum/pgsql，user 在 user）。本适配器只做形状转换。
type reportTargets struct{ m *Modules }

// reportUserTarget 是 report 的 user 级举报：target_type='user' 时 target_id 是那个人的 id。
const reportUserTarget = "user"

func (a reportTargets) ResolveTarget(ctx context.Context, targetType, publicID string) (report.TargetInfo, bool, error) {
	switch targetType {
	case report.TargetTopic:
		ref, err := a.m.fstore.TopicRef(ctx, publicID, 0, false)
		if errors.Is(err, forumpgsql.ErrNoRows) {
			return report.TargetInfo{}, false, nil
		}
		if err != nil {
			return report.TargetInfo{}, false, err
		}
		info, err := a.topicInfo(ctx, ref.ID, ref.AuthorID)
		return info, err == nil, err
	case report.TargetPost:
		ref, err := a.m.fstore.PostRef(ctx, publicID, 0, false)
		if errors.Is(err, forumpgsql.ErrNoRows) {
			return report.TargetInfo{}, false, nil
		}
		if err != nil {
			return report.TargetInfo{}, false, err
		}
		info, err := a.postInfo(ctx, ref.ID, ref.TopicID, ref.AuthorID, ref.PublicID)
		return info, err == nil, err
	case reportUserTarget:
		b, err := a.m.User.BriefByPublicID(ctx, publicID)
		if errors.Is(err, apperr.ErrNotFound) {
			return report.TargetInfo{}, false, nil
		}
		if err != nil {
			return report.TargetInfo{}, false, err
		}
		return report.TargetInfo{
			InternalID: b.ID, PublicID: b.PublicID, AuthorID: b.ID, Label: b.Nickname,
		}, true, nil
	default:
		return report.TargetInfo{}, false, nil
	}
}

// TargetInfo 按内部 id 还画像（管理队列用）。
// 目标后来被删掉时返回零值而不是错误：队列要能显示「这条举报的目标没了」，
// 不该因为一条已删的目标让整页 500。
func (a reportTargets) TargetInfo(ctx context.Context, targetType string, internalID int64) (report.TargetInfo, error) {
	switch targetType {
	case report.TargetTopic:
		ref, err := a.m.fstore.TopicRefByID(ctx, internalID)
		if errors.Is(err, forumpgsql.ErrNoRows) {
			return report.TargetInfo{}, nil
		}
		if err != nil {
			return report.TargetInfo{}, err
		}
		return a.topicInfo(ctx, ref.ID, ref.AuthorID)
	case report.TargetPost:
		ref, err := a.m.fstore.PostRefByID(ctx, internalID)
		if errors.Is(err, forumpgsql.ErrNoRows) {
			return report.TargetInfo{}, nil
		}
		if err != nil {
			return report.TargetInfo{}, err
		}
		return a.postInfo(ctx, ref.ID, ref.TopicID, ref.AuthorID, ref.PublicID)
	case reportUserTarget:
		b, err := a.m.User.BriefByID(ctx, internalID)
		if errors.Is(err, apperr.ErrNotFound) {
			return report.TargetInfo{}, nil
		}
		if err != nil {
			return report.TargetInfo{}, err
		}
		return report.TargetInfo{
			InternalID: b.ID, PublicID: b.PublicID, AuthorID: b.ID, Label: b.Nickname,
		}, nil
	default:
		return report.TargetInfo{}, nil
	}
}

func (a reportTargets) topicInfo(ctx context.Context, topicID, authorID int64) (report.TargetInfo, error) {
	card, err := a.m.fstore.TopicCard(ctx, topicID)
	if err != nil {
		if errors.Is(err, forumpgsql.ErrNoRows) {
			return report.TargetInfo{}, nil
		}
		return report.TargetInfo{}, err
	}
	return report.TargetInfo{
		InternalID: topicID, PublicID: card.PublicID, AuthorID: authorID, Label: card.Title,
		Board: &report.BoardRef{Slug: card.BoardSlug, Name: card.BoardName},
	}, nil
}

func (a reportTargets) postInfo(ctx context.Context, postID, topicID, authorID int64, publicID string) (report.TargetInfo, error) {
	info := report.TargetInfo{InternalID: postID, PublicID: publicID, AuthorID: authorID}
	// 楼层的「画像」就是它所在的主题：队列里给人看的一行是主题标题 + 分区。
	card, err := a.m.fstore.TopicCard(ctx, topicID)
	if err != nil {
		if errors.Is(err, forumpgsql.ErrNoRows) {
			return info, nil
		}
		return report.TargetInfo{}, err
	}
	info.Label = card.Title
	info.Board = &report.BoardRef{Slug: card.BoardSlug, Name: card.BoardName}
	return info, nil
}

// ── 审计 ─────────────────────────────────────────────────────────

// rewardAudit 让 reward 的审计与业务行同事务（两边的 Entry 字段一一对应，只差 ActorID 的
// 可空表示：reward 用 *int64，audit 用 0 = NULL）。
type rewardAudit struct{ w *audit.Writer }

func (a rewardAudit) Write(ctx context.Context, tx *ent.Tx, e reward.AuditEntry) error {
	return a.w.Write(ctx, tx, audit.Entry{
		ActorID: actorIDOf(e.ActorID), Action: e.Action, TargetType: e.TargetType,
		TargetID: e.TargetID, Detail: e.Detail, IP: e.IP,
	})
}

func actorIDOf(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// titleAudit 实现 title.AuditSink。
//
// shortcut: AuditSink.Log 不带事务，审计行只能独立提交（tx=nil）——头衔的授予**不是**
// 与审计同事务的。要严格同事务得给 title 域的接口加一个 *ent.Tx 参数，那动的是成型 service。
type titleAudit struct{ m *Modules }

func (a titleAudit) Log(ctx context.Context, e title.AuditEntry) error {
	return a.m.audit.Write(ctx, nil, audit.Entry{
		ActorID: e.ActorID, Action: e.Action, TargetType: e.TargetType,
		TargetID: e.TargetID, Detail: e.Detail, IP: e.IP,
	})
}
