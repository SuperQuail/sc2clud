package auth

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/netip"
	"strings"
	"time"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
	"forum/internal/ent"
	"forum/internal/ent/user"
	"forum/internal/platform/apperr"
	"forum/internal/platform/idgen"
)

// 动作名清单（设计 §8.10 的表）。**只有这一处定义**：action 是排障的第一索引，
// 散落的字符串会让「某类操作到底有没有留痕」无法回答。
const (
	ActionUserRegister      = "user.register"
	ActionUserLogin         = "user.login"
	ActionUserCreateAdmin   = "user.create_admin"
	ActionUserRoleAssign    = "user.role.assign"
	ActionUserBan           = "user.ban"
	ActionUserActivate      = "user.activate"
	ActionSessionsRevoke    = "user.sessions.revoke"
	ActionUserPasswordReset = "user.password.reset"
	ActionRolePermsEdit     = "role.permissions.edit"
	ActionPermissionGrant   = "permission.grant"
	ActionPermissionRevoke  = "permission.revoke"
	ActionPermissionExpire  = "permission.expire"
	ActionPasswordChange    = "auth.password.change"
	ActionEmailVerify       = "auth.email.verify"
	ActionAuditExport       = "audit.export"
)

// AuditEntry 是一次审计写入。detail 只有两个形状：{"before": …} 与 {"before": …, "after": …}。
type AuditEntry struct {
	ActorID    int64 // 0 = CLI / 系统动作（库里存 NULL）
	Action     string
	TargetType string
	TargetID   string // public_id 或业务 key，**不存自增 id**
	Detail     map[string]any
	IP         netip.Addr
}

// writeAudit 是**写审计的唯一入口**，且必须在业务事务里调用（设计 §8.10：
// 同事务的代价是「审计写失败会让业务失败」，换来的性质是「不存在操作发生了但没记录」）。
func (s *Service) writeAudit(ctx context.Context, tx *ent.Tx, e AuditEntry) error {
	if e.Detail == nil {
		e.Detail = map[string]any{}
	}
	c := tx.AuditLog.Create().
		SetAction(e.Action).
		SetTargetType(e.TargetType).
		SetTargetID(e.TargetID).
		SetDetail(e.Detail).
		SetCreatedAt(s.clk.Now())
	if e.ActorID != 0 {
		c.SetActorID(e.ActorID)
	}
	if e.IP.IsValid() {
		c.SetIP(e.IP.String())
	}
	return c.Exec(ctx)
}

// ── 审计查询与导出 ──────────────────────────────────────────────────

// AuditQuery 是 GET /admin/audit-logs 的筛选参数。
type AuditQuery struct {
	TargetType    string
	TargetID      string
	Action        string
	ActorPublicID string
	From          *time.Time
	To            *time.Time
	Limit         int
	Cursor        string
}

// AuditItem 是一条审计的对外形状。
type AuditItem struct {
	ID         int64          `json:"id"`
	CreatedAt  time.Time      `json:"created_at"`
	Action     string         `json:"action"`
	TargetType string         `json:"target_type"`
	TargetID   string         `json:"target_id"`
	Detail     map[string]any `json:"detail"`
	IP         string         `json:"ip"`
	Actor      *AuditActor    `json:"actor"`
}

// AuditActor 是操作者的展示字段（CLI 与系统动作为 null）。
type AuditActor struct {
	ID       string `json:"id"`
	Handle   string `json:"handle"`
	Nickname string `json:"nickname"`
}

// auditCursor 是 (created_at DESC, id DESC) 的游标。
// 游标里的自增 id 不违反拍板 §5.6：它是不透明串，前端只回传不解释。
type auditCursor struct {
	K  string `json:"k"` // RFC3339Nano
	ID int64  `json:"id"`
}

func encodeAuditCursor(t time.Time, id int64) string {
	b, _ := json.Marshal(auditCursor{K: t.UTC().Format(time.RFC3339Nano), ID: id})
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeAuditCursor(s string) (time.Time, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, 0, apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
	}
	var c auditCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return time.Time{}, 0, apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
	}
	t, err := time.Parse(time.RFC3339Nano, c.K)
	if err != nil {
		return time.Time{}, 0, apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
	}
	return t, c.ID, nil
}

// normalizeLimit 是拍板 §5.1：默认 20、上限 100（超出按 100，不报错）。
func normalizeLimit(n int) int {
	if n <= 0 {
		return 20
	}
	if n > 100 {
		return 100
	}
	return n
}

// ListAuditLogs 返回一页审计与下一页游标（空串表示到底）。
func (s *Service) ListAuditLogs(ctx context.Context, actor *authz.Actor, in AuditQuery) ([]AuditItem, string, error) {
	if err := requirePerm(actor, authz.PermAuditView); err != nil {
		return nil, "", err
	}
	f, err := s.auditFilter(ctx, in)
	if err != nil {
		return nil, "", err
	}
	limit := normalizeLimit(in.Limit)
	f.Limit = limit + 1 // 多取一行判断有没有下一页

	rows, err := pgsql.ListAudit(ctx, s.db, f)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = encodeAuditCursor(last.CreatedAt, last.ID)
	}
	out := make([]AuditItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, toAuditItem(r))
	}
	return out, next, nil
}

// exportBatch 是导出时每批取多少行（设计 §13.2 第 1 条：不要一次 FetchAll，5 万行 JSON 会吃掉几十 MB）。
const exportBatch = 1000

// ExportAuditCSV 边写边发地导出审计。
//
// 它是本域唯一直接写 w 的端点（设计 §13.2 第 4 条），所以它不经过 httpx.OK：
// handler 自己设 Content-Type 与 Content-Disposition，再把它接到 c.Writer。
func (s *Service) ExportAuditCSV(ctx context.Context, actor *authz.Actor, in AuditQuery, w io.Writer) error {
	if err := requirePerm(actor, authz.PermAuditExport); err != nil {
		return err
	}
	f, err := s.auditFilter(ctx, in)
	if err != nil {
		return err
	}
	// 单次最多 50000 行，limit 只能下调（设计 §13.2）。
	const hardMax = 50000
	if f.Limit <= 0 || f.Limit > hardMax {
		f.Limit = hardMax
	}
	f.CursorAt, f.CursorID = nil, 0

	// U10 定案：导出这个动作**自己必须留痕**，写在读取之前——所以导出的 CSV 里不含这一行。
	if err := s.withTx(ctx, func(tx *ent.Tx) error {
		return s.writeAudit(ctx, tx, AuditEntry{
			ActorID: actor.UserID, Action: ActionAuditExport, TargetType: "audit_log",
			TargetID: timeStr(in.From) + "~" + timeStr(in.To),
			Detail: map[string]any{"after": map[string]any{
				"format": "csv", "from": timeStr(in.From), "to": timeStr(in.To),
			}},
		})
	}); err != nil {
		return err
	}

	// UTF-8 BOM：没有它，中文 Windows 的 Excel 打开是乱码（设计 §13.2 第 2 条）。
	if _, err := w.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
		return err
	}
	cw := csv.NewWriter(w)
	if err := cw.Write([]string{"created_at", "actor_handle", "action", "target_type", "target_id", "ip", "detail"}); err != nil {
		return err
	}

	written := 0
	for written < f.Limit {
		f.Limit = min(exportBatch, f.Limit-written)
		rows, err := pgsql.ListAudit(ctx, s.db, f)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			detail, err := json.Marshal(r.Detail)
			if err != nil {
				return fmt.Errorf("auth: 审计 detail 编码失败: %w", err)
			}
			rec := []string{
				r.CreatedAt.UTC().Format(time.RFC3339),
				deref(r.ActorHandle),
				r.Action, r.TargetType, r.TargetID,
				ipText(r.IP), string(detail),
			}
			for i := range rec {
				rec[i] = csvSafe(rec[i])
			}
			if err := cw.Write(rec); err != nil {
				return err
			}
		}
		written += len(rows)
		last := rows[len(rows)-1]
		f.CursorAt, f.CursorID = &last.CreatedAt, last.ID
	}
	cw.Flush()
	return cw.Error()
}

// csvSafe 是 CSV 注入防护（设计 §13.2 第 3 条）：以 = + - @ 制表符 回车 开头的单元格前加一个单引号。
// detail 与 target_id 里全是用户可控内容，Excel 会把 =cmd|... 当公式执行。
func csvSafe(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}

func timeStr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func ipText(a *netip.Addr) string {
	if a == nil {
		return ""
	}
	return a.String()
}

// auditFilter 组装查询条件，并把 actor 的 public_id 翻成自增 id（筛选走 idx_audit_logs_actor）。
func (s *Service) auditFilter(ctx context.Context, in AuditQuery) (pgsql.AuditFilter, error) {
	f := pgsql.AuditFilter{
		TargetType: strings.TrimSpace(in.TargetType),
		TargetID:   strings.TrimSpace(in.TargetID),
		Action:     strings.TrimSpace(in.Action),
		From:       in.From,
		To:         in.To,
		Limit:      in.Limit,
	}
	if in.ActorPublicID != "" {
		uid, err := idgen.ParsePublicID(in.ActorPublicID)
		if err != nil {
			return f, apperr.Invalid(map[string]string{"actor": "不是合法的用户 ID"})
		}
		id, err := s.db.User.Query().Where(user.PublicIDEQ(uid)).OnlyID(ctx)
		if err == nil {
			f.ActorID = &id
		} else if !ent.IsNotFound(err) {
			return f, err
		} else {
			// 操作者不存在 → 结果必然为空。用一个不可能的 id 表达，不为它造特殊分支。
			none := int64(-1)
			f.ActorID = &none
		}
	}
	if in.Cursor != "" {
		at, id, err := decodeAuditCursor(in.Cursor)
		if err != nil {
			return f, err
		}
		f.CursorAt, f.CursorID = &at, id
	}
	return f, nil
}

func toAuditItem(r pgsql.AuditRow) AuditItem {
	item := AuditItem{
		ID: r.ID, CreatedAt: r.CreatedAt, Action: r.Action,
		TargetType: r.TargetType, TargetID: r.TargetID, Detail: r.Detail,
		IP: ipText(r.IP),
	}
	if r.ActorPublicID != nil {
		item.Actor = &AuditActor{ID: *r.ActorPublicID, Handle: deref(r.ActorHandle), Nickname: deref(r.ActorNickname)}
	}
	return item
}
