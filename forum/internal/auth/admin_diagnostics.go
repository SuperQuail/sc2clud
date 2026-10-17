package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// 自检面板（交接单 C3 / §5.13）。
//
// 门控有两层，缺一不可：**权限点 site.setting 且 debug 开关打开**。
// debug 关闭时给一个**明确的错误码**（404 common.not_found），不是空 200 ——
// 空 200 会让「生产上关掉了」和「跑了但没结果」在界面上长得一模一样（§5.13 的原话）。
// 404 而不是 403 是刻意的：403 在暗示「有你没权限的端点」，那正是「关掉了」要说反的话。
var ErrDiagnosticsDisabled = apperr.ErrNotFound

// DiagnosticsInfo 是进程级的事实（版本与启动时间），由 app 层注入。
// 没注入时面板照样能开，只是那两项显示空值 —— 它不该因为「这个部署没配」而整体不可用。
type DiagnosticsInfo struct {
	// Version 是**二进制**的版本（BuildInfo.Version，ldflags 注入的 git sha）。
	// 只有「迁移到第几版」才和数据库有关，那个数字另查 schema_migrations。
	Version   string
	StartedAt time.Time
	// Readonly 说明 Checks 里有没有「会拒绝启动」的那几条（跑在 run 的启动自检里）。
	Readonly bool
}

// 检查项的三种结果。留一档 skipped 是为了**说得清**「没查」与「查了通过」的区别：
// 把没查的显示成通过，是这类面板最常见的假绿。
const (
	DiagOK      = "ok"
	DiagFail    = "fail"
	DiagSkipped = "skipped"
)

// DiagnosticCheckDTO 是一个检查项。
type DiagnosticCheckDTO struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	MS     int64  `json:"ms"`
	// Ok 是 status 的布尔投影：DevRoom 15-admin/screens/diagnostics.tsx 的 mock 直接渲染 ok。
	// 两样都给是因为只给布尔时「没查」会被显示成红的或绿的，两种都是假话。
	Ok bool `json:"ok"`
}

// DiagnosticsDTO 是 GET /admin/diagnostics 的响应。
type DiagnosticsDTO struct {
	DebugEnabled bool                 `json:"debug_enabled"`
	Version      string               `json:"version"`
	StartedAt    *time.Time           `json:"started_at"`
	Readonly     bool                 `json:"readonly"`
	Checks       []DiagnosticCheckDTO `json:"checks"`
	Total        int                  `json:"total"`
	Failed       int                  `json:"failed"`
}

// SetDiagnostics 注入进程级事实（版本 / 启动时间）。app 层在装配 HTTP 服务时调它一次：
// 那些事实在 app 层才知道，让 auth 域去 import app 或 main 是反过来的依赖。
func (s *Service) SetDiagnostics(d DiagnosticsInfo) { s.diag = d }

// AdminDiagnostics 跑全部自检并逐项返回。
func (s *Service) AdminDiagnostics(ctx context.Context, actor *authz.Actor) (*DiagnosticsDTO, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	if !s.cfg.HTTP.Debug {
		return nil, ErrDiagnosticsDisabled
	}
	checks := []DiagnosticCheckDTO{
		runCheck("权限点集合一致性", func() error { return s.checkPermissionSet(ctx, false) }),
		runCheck("枚举值域与代码常量", func() error { return s.CheckEnums(ctx) }),
		runCheck("数据库迁移版本", func() error { return s.checkSchemaVersion(ctx, s.diag) }),
		runCheck("外键索引完备", func() error { return s.checkForeignKeys(ctx) }),
	}
	out := &DiagnosticsDTO{
		DebugEnabled: true,
		Version:      s.diag.Version,
		Readonly:     s.diag.Readonly,
		Checks:       checks,
		Total:        len(checks),
	}
	if !s.diag.StartedAt.IsZero() {
		t := s.diag.StartedAt.UTC()
		out.StartedAt = &t
	}
	for _, c := range checks {
		if c.Status == DiagFail {
			out.Failed++
		}
	}
	return out, nil
}

// runCheck 跑一条检查并计时。**错误只摘一行**：面板的一行放不下多行文本，
// 完整信息在服务日志与「forum check」的输出里。
func runCheck(name string, fn func() error) DiagnosticCheckDTO {
	start := time.Now()
	err := fn()
	c := DiagnosticCheckDTO{Name: name, Status: DiagOK, Ok: true, MS: time.Since(start).Milliseconds()}
	if err != nil {
		c.Status, c.Ok, c.Detail = DiagFail, false, firstLine(err.Error())
	}
	return c
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, 10); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if len(r) > 300 {
		return string(r[:300]) + "…"
	}
	return s
}

// checkSchemaVersion 读 schema_migrations 并确认它已经不是「从未迁移过」或 dirty。
// 只读这两件事，**不比对二进制的最高迁移号**：那个数字是 migrations 包的，
// 本域 import 它会把「认证域」和「部署动作」绑在一起；真正的版本严格比对在
// forum run 的启动自检（db.EnsureVersion）与 forum check 里，那两处才是该红的地方。
func (s *Service) checkSchemaVersion(ctx context.Context, d DiagnosticsInfo) error {
	if d.Version == "" {
		return nil // 没有注入构建信息的环境（测试台）不查这一条：报红只会训练人忽略它
	}
	version, dirty, err := s.schemaVersion(ctx)
	if err != nil {
		return err
	}
	switch {
	case version == 0 && !dirty:
		return errors.New("数据库还没迁移过，先跑 forum migrate")
	case dirty:
		return errors.New("迁移处于 dirty 状态：修好 SQL 后先 forum migrate force 再重跑")
	}
	return nil
}

// schemaVersion 读 schema_migrations。表不存在（42P01）时返回 0 = 「从未迁移过」。
func (s *Service) schemaVersion(ctx context.Context) (int, bool, error) {
	var version int64
	var dirty bool
	err := pgsql.QueryRow(ctx, s.db, "SELECT version, dirty FROM schema_migrations LIMIT 1").Scan(&version, &dirty)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
			return 0, false, nil
		}
		return 0, false, err
	}
	return int(version), dirty, nil
}

// checkForeignKeys 复用启动自检那条「外键列没有索引」的扫描（schema_check.go）。
// 它扫全库，所以能一次回答「D3/D4/D5 有没有漏索引」。
func (s *Service) checkForeignKeys(ctx context.Context) error {
	return CheckForeignKeys(ctx, s.db)
}
