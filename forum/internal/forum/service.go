// Package forum 是论坛核心域：分区 / 主题 / 回复 / 投票 / 收藏 / 拉黑 / 下载源 / Issue。
//
// 三条贯穿全域的做法（d3-forum §0）：
//  1. **过滤条件只写一次**：可见性条件在 pgsql 包的 SQL 里逐条显式写出，四条列表共用同一形状；
//  2. **游标排序键与索引逐字对齐**：每条查询在 pgsql 包里注明了它吃哪个索引；
//  3. **写路径上的判定顺序写下来**（acl.go 的 canSpeak），不靠实现者记忆。
//
// 本包只做业务判断：SQL 全在 internal/forum/pgsql，HTTP 全在 handler.go。
package forum

import (
	"context"
	"errors"
	"log/slog"
	"strconv"

	"github.com/jackc/pgx/v5/pgconn"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/queue"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// Service 是本域的全部业务逻辑。actor 由 handler **显式传入**（拍板 §5.3），不从 context 取。
type Service struct {
	db    *ent.Client
	repo  *pgsql.Store
	clk   clock.Clock
	count Counter
	q     Queue
	deps  Deps
	log   *slog.Logger
}

// NewService 的签名就是接线契约：db / 时钟 / 计数器 / 队列 / 别人的能力。
// 事务一律 db.WithTx（platform/db），本域不自己开事务。
func NewService(db *ent.Client, clk clock.Clock, counters Counter, q Queue, deps Deps) *Service {
	if counters == nil {
		counters = nopCounter{}
	}
	return &Service{
		db:    db,
		repo:  pgsql.NewStore(db),
		clk:   clk,
		count: counters,
		q:     q,
		deps:  deps,
		log:   slog.Default(),
	}
}

// nopCounter 只在测试里没有计数器时兜底：它不改变任何行为，只是让 Add/Get 可用。
type nopCounter struct{}

func (nopCounter) Add(string, int64) {}
func (nopCounter) Get(string) int64  { return 0 }

// ---- 身份与权限 ----

// requireActor 是所有写路径的第一道闸：actor 必须是登录者（nil → 401）。
func requireActor(actor *authz.Actor) (*authz.Actor, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	return actor, nil
}

// requirePerm 判全局权限点。超管短路必须放在权限集合之前（authz 的硬规则 2）。
func requirePerm(actor *authz.Actor, perm string) error {
	if actor.IsSuper || actor.Perms.Has(perm) {
		return nil
	}
	return apperr.ErrForbidden
}

// viewerID 返回「当前用户 id，游客 0」。0 在 SQL 里是「没有这个人」的哨兵：
// 它让列表与详情的三条过滤条件（我的票、我的收藏、作者可见性）不需要分支。
func viewerID(actor *authz.Actor) int64 {
	if actor == nil {
		return 0
	}
	return actor.UserID
}

// canReview 判「持 post.review」：审核队列与审核详情用它（公开路径恒 false）。
func canReview(actor *authz.Actor) bool {
	return actor != nil && (actor.IsSuper || actor.Perms.Has(authz.PermPostReview))
}

// canEditTopic 判「改 / 删这条主题」：作者走 own，其他人走 any 或 board.moderate + 分区。
// 两条件是 AND：**先 Require 再判归属 / 作用域**（拍板 §1.2 的收尾语）。
func canEditTopic(actor *authz.Actor, ownPerm, anyPerm string, authorID, boardID int64) bool {
	if actor == nil {
		return false
	}
	if actor.UserID == authorID && (actor.IsSuper || actor.Perms.Has(ownPerm)) {
		return true
	}
	if actor.IsSuper || actor.Perms.Has(anyPerm) {
		return true
	}
	return actor.Perms.Has(authz.PermBoardModerate) && authz.CanInBoard(actor, boardID)
}

// canLockTopic 是锁主题 / 关 Issue 的同一个判定（§7.5：关 Issue 与锁主题是同一类动作）。
func canLockTopic(actor *authz.Actor, authorID, boardID int64) bool {
	if actor == nil {
		return false
	}
	if actor.UserID == authorID && (actor.IsSuper || actor.Perms.Has(authz.PermTopicEditOwn)) {
		return true
	}
	if actor.IsSuper || actor.Perms.Has(authz.PermTopicLock) {
		return true
	}
	return actor.Perms.Has(authz.PermBoardModerate) && authz.CanInBoard(actor, boardID)
}

// render 是 Markdown → (html, plain) 的唯一入口。没有配渲染器时**不静默降级成原文 HTML**：
// 那是把「用户输入的 markdown」直接当 HTML 发出去，等于 XSS。宁可报 500。
func (s *Service) render(md string) (string, string, error) {
	if s.deps.Render == nil {
		return "", "", errNoRenderer
	}
	html, plain := s.deps.Render.Render(md)
	return html, plain, nil
}

// enqueue 只在事务里用（EnqueueTx）：事务回滚则任务不存在（拍板 §5.4）。
func (s *Service) enqueue(ctx context.Context, tx *ent.Tx, t queue.Task) error {
	if s.q == nil {
		return nil
	}
	return s.q.EnqueueTx(ctx, tx, t)
}

// clipExcerpt 从纯文本切摘要。varchar(200) 是硬上限，按**字符**切而不是按字节。
func clipExcerpt(plain string) string {
	const max = 200
	r := []rune(plain)
	if len(r) <= max {
		return plain
	}
	return string(r[:max])
}

// clip 按字符截断，用于 error message 之类的展示文本。
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// counterTopicViewKey 是浏览量计数的键。格式必须与 platform/counter 的解析一致：
// counter.Kind(key) 按 "view:topic:<id>" 拆表与列（§8.2）。
func counterTopicViewKey(topicID int64) string { return "view:topic:" + itoa64(topicID) }

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

// isUniqueViolation 判「唯一约束冲突」。唯一索引撞车与唯一约束撞车的 SQLSTATE 都是 23505。
func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
