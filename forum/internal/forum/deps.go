package forum

import (
	"context"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/image"
	"forum/internal/platform/queue"
)

// 本域需要的外部能力，形状取到最小；业务模块之间禁止互相 import，这些接口由 app 层填。
// 依据：d3-forum §9.4（只有本域真正会调的方法，没有大接口、没有 HasPerm 转发）。
type (
	// UserLookup 由 internal/user.Service 实现。
	// GetAuthBrief 是「发帖审核豁免 + 等级门槛」两个字段的唯一来源：为此查两次 users 不值。
	UserLookup interface {
		GetAuthBrief(ctx context.Context, userID int64) (*UserAuthBrief, error)
		ByHandle(ctx context.Context, handle string) (*UserBrief, error)
	}

	// Renderer 由 platform/markdown 实现。plain 与 html 必须同源，
	// 否则会出现「正文里看得到、摘要里看不到」的字符（§9.4 末段）。
	Renderer interface {
		Render(md string) (html string, plain string)
	}

	// Queue 由 platform/queue 实现。事务内的任务必须走 EnqueueTx（拍板 §5.4）：
	// 事务回滚则任务不存在。
	Queue interface {
		EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
	}

	// Counter 由 platform/counter.Buffer 实现：浏览量、转链计数都只进缓冲。
	Counter interface {
		Add(key string, delta int64)
		Get(key string) int64
	}

	// Limiter 由 platform/ratelimit 实现。转链端点 30/分钟/IP（§7.2）。
	Limiter interface {
		Allow(ctx context.Context, key string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error)
	}
)

// notify 的 ref_type（通知 payload 的取值）。**与 notify 包的同名常量同值**：
// 它不是本域的实现细节，而是两个模块之间的线格式（接口定稿补充 §8.1）。
// 为什么在这里再写一遍：notify 与 forum 禁止互相 import（两个域各写一半），
// 所以这份契约只能各持一半——「两边同值」由 app 包那条端到端用例证明
// （internal/app/e2e_test.go：任务 done 之外**还要**通知表里真的多一行）。
// 注意 likes.target_type（库里第三套名字）与它不同：issue_comment → comment 的换算
// 在 votes.go 的 resolveVoteTarget 里做，只做一次。
const (
	notifyRefPost    = "post"
	notifyRefTopic   = "topic"
	notifyRefComment = "comment"
)

// UserAuthBrief 是发帖门槛与审核豁免要的两个字段（§9.4）。
type UserAuthBrief struct {
	ID      int64
	Trusted bool
	Level   int
	Status  string
}

// UserBrief 是列表卡片上的作者三字段 + 主页地址。
type UserBrief struct {
	ID          int64
	PublicID    string
	Handle      string
	Nickname    string
	AvatarHash  string
	AvatarSmall string
	Status      string
}

// Media 由 media.Service 实现（d5 §4.3）：**引用计数只有这一个入口**，别的域不许自己写 images 的 SQL。
//
// 为什么分区封面必须走它（2026-10-14 补）：图片经 /me/cover 上传时那一行 refcount=1，
// 而论坛域把 hash 挂到 boards.cover_hash 上时既没 +1、换图/清空时也没 −1 ——
// 结果是**换掉的旧分区封面永远留在盘上**（GC 只收 refcount 归零的行，永远轮不到它）。
// 注意传的是**裸 hash 字符串**（boards.cover_hash 存的就是它），不是图片 URL。
type Media interface {
	IncRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error
	DecRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error
}

// Deps 是本域的全部外部依赖。app 层组装；测试里传假实现。
type Deps struct {
	Users   UserLookup
	Render  Renderer
	Queue   Queue
	Counter Counter
	Limit   Limiter
	Media   Media
	// TZ 是站点时区（D7）：分区列表的「今日」按它算零点。nil = 兜底 Asia/Shanghai。
	// 由 app 层从 config 解析好传进来 —— 本域不 import config（域与配置解耦，测试好造）。
	TZ *time.Location
	// InvalidateUser 由 auth 的 InvalidateUser 填（C2 的版主任免要用）。
	//
	// 为什么必须有：actor.BoardIDs 来自会话解析那条 SQL，缓存住的话刚被免掉的人在缓存过期前
	// 仍然是该分区的版主（能锁主题、能关 Issue）—— 那是权限泄漏，不是显示延迟。
	// 写 board_moderators 之后调它是 D2 定下的约定（见 ent 的 board_moderator.go 文件头）。
	// nil = 没接线（测试台），按「本轮无缓存」处理。
	InvalidateUser func(ctx context.Context, userID int64) error
}
