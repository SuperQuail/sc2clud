// Package report 是举报域：提交、我的举报、管理员队列、处理（放行 / 驳回）与阈值触发复核。
//
// 依据：完全重构/后端设计/d6-reward.md §2.2 / §5.3 / §6.5–§6.6 / §7.6；拍板 §4（表与索引）、
// §8.11 U4/U5（不能举报自己、重复举报幂等 200）、§10.4（举报阈值触发复核）。
//
// 两个刻意不做的联动（写在这里免得以后有人加）：
//   - 处理举报**不联动封号**：封号是 user.ban，与 report.handle 是两个权限点（d6 §6.6）；
//   - 举报**不做自动处置**：误伤的代价不可逆（d6 §12）。
package report

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	"forum/internal/platform/clock"
	platformdb "forum/internal/platform/db"
	"forum/internal/report/pgsql"
)

// 阈值读不到站点设置时的默认值（与 internal/site 键值表里的默认值同值；生产路径一定读得到）。
const (
	defaultThreshold1 = 3
	defaultThreshold2 = 5
)

// Service 是举报域的全部业务逻辑。actor 由 handler 显式传入（拍板 §5.3），不从 context 取。
type Service struct {
	db      *ent.Client
	pg      *pgsql.Queries
	targets TargetResolver
	users   UserLookup
	set     Settings
	review  ReviewTrigger
	audit   *audit.Writer
	clk     clock.Clock
	log     *slog.Logger
}

// NewService 的签名就是接线契约：db / 目标解析 / 用户画像 / 站点设置 / 复核触发 / 审计 / 时钟 / 日志。
func NewService(db *ent.Client, tg TargetResolver, users UserLookup, set Settings, review ReviewTrigger,
	a *audit.Writer, clk clock.Clock, log *slog.Logger) *Service {
	return &Service{
		db: db, pg: pgsql.New(db), targets: tg, users: users, set: set,
		review: review, audit: a, clk: clk, log: log,
	}
}

// requirePerm 是 service 层兜底：队列 / CLI 不走路由，也要挡住（拍板 §5.3）。
func requirePerm(actor *authz.Actor, perm string) error {
	if actor == nil || actor.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	if !actor.IsSuper && !actor.Perms.Has(perm) {
		return apperr.ErrForbidden
	}
	return nil
}

// thresholds 读两个举报阈值（站点设置，默认 3 / 5）。
// 没接站点设置时用代码默认值：阈值是运营参数，缺它不该让举报功能失效。
func (s *Service) thresholds(ctx context.Context) (int, int) {
	if s.set == nil {
		return defaultThreshold1, defaultThreshold2
	}
	return s.set.SettingInt(ctx, settingThreshold1), s.set.SettingInt(ctx, settingThreshold2)
}

// ---- 游标分页（拍板 §5.1：排序键永远带 id 兜底）----

func encodeCursor(t time.Time, id int64) string {
	b, err := json.Marshal(cursor{T: t.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (*cursor, error) {
	if s == "" {
		return nil, nil
	}
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

// ---- 视图组装 ----

// targetKey 是「目标」在缓存里的键（type + 内部 id）。
func targetKey(targetType string, id int64) string {
	return targetType + ":" + fmt.Sprint(id)
}

// views 把一页举报行转成 DTO：目标画像与用户画像各解析一次（一页里同一个目标/同一个人只查一次）。
func (s *Service) views(ctx context.Context, rows []*ent.Report) ([]Report, error) {
	briefs := map[int64]UserBrief{}
	targets := map[string]TargetInfo{}
	counts := map[string]int{}
	out := make([]Report, 0, len(rows))

	for _, r := range rows {
		key := targetKey(r.TargetType, r.TargetID)
		info, ok := targets[key]
		if !ok {
			var err error
			info, err = s.targets.TargetInfo(ctx, r.TargetType, r.TargetID)
			if err != nil {
				return nil, fmt.Errorf("读被举报目标 %s: %w", key, err)
			}
			targets[key] = info
		}
		n, ok := counts[key]
		if !ok {
			var err error
			n, err = s.pg.CountOpenForTarget(ctx, r.TargetType, r.TargetID)
			if err != nil {
				return nil, err
			}
			counts[key] = n
		}
		item, err := s.view(ctx, r, info, n, briefs)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

// view 组装单条 DTO；briefs 是用户画像缓存（同一页里同一个人只查一次）。
func (s *Service) view(ctx context.Context, r *ent.Report, info TargetInfo, openReports int, briefs map[int64]UserBrief) (Report, error) {
	reporter, err := s.brief(ctx, r.ReporterID, briefs)
	if err != nil {
		return Report{}, err
	}
	out := Report{
		ID: r.PublicID.String(), TargetType: r.TargetType, TargetID: info.PublicID,
		TargetLabel: info.Label, Board: info.Board,
		Reason: r.Reason, Detail: r.Detail, Reporter: &reporter,
		State: r.State, HandledAt: r.HandledAt, HandleNote: r.HandleNote,
		CreatedAt: r.CreatedAt, OpenReports: openReports,
	}
	if r.HandlerID != nil {
		h, err := s.brief(ctx, *r.HandlerID, briefs)
		if err != nil {
			return Report{}, err
		}
		out.Handler = &h
	}
	return out, nil
}

func (s *Service) brief(ctx context.Context, userID int64, cache map[int64]UserBrief) (UserBrief, error) {
	if b, ok := cache[userID]; ok {
		return b, nil
	}
	b, err := s.users.Basic(ctx, userID)
	if err != nil {
		return UserBrief{}, fmt.Errorf("读用户画像 %d: %w", userID, err)
	}
	cache[userID] = b
	return b, nil
}

// handleBatch 是一个管理员意图 = 一个事务 + 逐条 CAS（d6 §6.3/§6.6）。
// 一条冲突（已经处理过）不该把整批回滚 —— 结果逐条给出。
func (s *Service) handleBatch(ctx context.Context, actor *authz.Actor, ids []string, state, note, ip string) (*BatchResult, error) {
	out := &BatchResult{Results: make([]BatchItem, 0, len(ids))}
	err := platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		txq := pgsql.NewTx(tx)
		for _, id := range ids {
			n, err := txq.HandleCAS(ctx, id, state, actor.UserID, note, s.clk.Now())
			if err != nil {
				return err
			}
			item := BatchItem{ID: id, OK: n > 0}
			if n == 0 {
				item.Code = ErrAlreadyHandled.Code
			} else if err := s.audit.Write(ctx, tx, audit.Entry{
				ActorID: actor.UserID, Action: actionReportHandle,
				TargetType: "report", TargetID: id,
				Detail: map[string]any{"after": map[string]any{"state": state, "handle_note": note}},
				IP:     ip,
			}); err != nil {
				return err
			}
			out.Results = append(out.Results, item)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
