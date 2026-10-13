package auth

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
)

// 启动自检（设计 §14）：全部要能跑、而且**都要能红**。
// 跑在「迁移版本检查之后、开始监听之前」；返回 error 就是拒绝启动。

// CheckPermissions 比对代码常量与 permissions 表（§14.1）。
// 代码有、表里没有 → 启动失败：那个权限点永远判不过，是一条**静默失效的鉴权**。
// 表里有、代码没有 → 只 Warn：库里多一行不影响任何判定，但值得提醒它指向一个已删的点。
func (s *Service) CheckPermissions(ctx context.Context) error {
	rows, err := s.db.Permission.Query().Select().All(ctx)
	if err != nil {
		return fmt.Errorf("自检：读 permissions 失败: %w", err)
	}
	have := make(map[string]struct{}, len(rows))
	for _, p := range rows {
		have[p.Key] = struct{}{}
	}
	var missing, extra []string
	for _, k := range authz.All {
		if _, ok := have[k]; !ok {
			missing = append(missing, k)
		}
	}
	known := make(map[string]struct{}, len(authz.All))
	for _, k := range authz.All {
		known[k] = struct{}{}
	}
	for _, p := range rows {
		if _, ok := known[p.Key]; !ok {
			extra = append(extra, p.Key)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		s.log.Warn("自检：permissions 表里有代码不认识的权限点（不影响判定，可清理）", "keys", extra)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("自检：permissions 表缺 %d 个权限点 %v —— 迁移没跑或代码常量比迁移新",
			len(missing), missing)
	}
	return nil
}

// enumChecks 是「CHECK 约束的值域必须等于代码里的常量集合」（§14.2）。
var enumChecks = []struct {
	table, column string
	want          []string
}{
	{"users", "status", []string{"active", "banned", "deleted"}},
	{"email_tokens", "purpose", []string{"verify", "reset"}},
}

// CheckEnums 的要点：pg_get_constraintdef 在某些设置下会输出**双引号**，
// 写死单引号会在真库上静默比不过（检查通过但什么都没查）。所以正则两种引号都认（设计 §14.2）。
func (s *Service) CheckEnums(ctx context.Context) error {
	for _, ec := range enumChecks {
		var def string
		err := pgsql.QueryRow(ctx, s.db, `
			SELECT pg_get_constraintdef(c.oid)
			  FROM pg_constraint c
			  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
			 WHERE c.conrelid = $1::regclass AND c.contype = 'c' AND a.attname = $2`,
			ec.table, ec.column).Scan(&def)
		if err != nil {
			return fmt.Errorf("自检：读 %s.%s 的 CHECK 失败: %w", ec.table, ec.column, err)
		}
		got := QuotedLiterals(def)
		if !sameSet(got, ec.want) {
			return fmt.Errorf("自检：枚举不一致 %s.%s 迁移=%v 代码=%v", ec.table, ec.column, got, ec.want)
		}
	}
	return nil
}

var literalRe = regexp.MustCompile("'([^']*)'|\"([^\"]*)\"")

// QuotedLiterals 从 pg_get_constraintdef 的文本里抠出所有字面量（单引号与双引号都认）。
// 它是 CheckEnums 的唯一解析处，单独可测——「静默比不过」是本域最危险的一类自检 bug（§18.7 第 81 条）。
func QuotedLiterals(def string) []string {
	var out []string
	for _, m := range literalRe.FindAllStringSubmatch(def, -1) {
		lit := m[1]
		if lit == "" {
			lit = m[2]
		}
		out = append(out, lit)
	}
	sort.Strings(out)
	return out
}

func sameSet(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	g := append([]string(nil), got...)
	w := append([]string(nil), want...)
	sort.Strings(g)
	sort.Strings(w)
	return strings.Join(g, "\x00") == strings.Join(w, "\x00")
}

// rolePermCounts 是迁移数据的期望值（0017_seed_authz：user 3 / creator 8 / admin 17 / superadmin 24）。
// 数字对不上只 Warn 不失败：生产上管理员合法地调过矩阵也会触发它（设计 §14.2）。
var rolePermCounts = map[string]int{"user": 3, "creator": 8, "admin": 17, "superadmin": 24}

// CheckRoleSeeds 返回统计并在数字不对时 Warn。它同时能回答「迁移数据被谁改过」。
func (s *Service) CheckRoleSeeds(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.key, (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id)
		  FROM roles r WHERE r.key IN ('user','creator','admin','superadmin')`)
	if err != nil {
		return fmt.Errorf("自检：读角色权限数失败: %w", err)
	}
	defer rows.Close()
	seen := map[string]int{}
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			return err
		}
		seen[k] = n
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for k, want := range rolePermCounts {
		got, ok := seen[k]
		if !ok {
			s.log.Warn("自检：内置角色不存在（迁移 0017_seed_authz 没跑？）", "role", k)
			continue
		}
		if got != want {
			s.log.Warn("自检：内置角色的权限数与 seed 不一致（后台改过就属正常）",
				"role", k, "got", got, "seed", want)
		}
	}
	return nil
}

// QueryContexter 是全库自检需要的形状：*sql.DB 与 *pgxpool.Pool 都满足它。
type QueryContexter interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// CheckForeignKeys 扫全库「外键列没有索引」的情况（数据库文档 §12 第 1 条 / 设计 §14.3）。
// 它扫的是所有表，所以 D3/D4 漏索引也会在这里红——**报错必须带表名**。
// 跑在 forum check 与 CI，不在 forum run 里。
func CheckForeignKeys(ctx context.Context, db QueryContexter) error {
	rows, err := db.QueryContext(ctx, `
		SELECT c.conrelid::regclass::text AS tbl, c.conname, a.attname
		  FROM pg_constraint c
		  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		 WHERE c.contype = 'f'
		   AND NOT EXISTS (
		     SELECT 1 FROM pg_index i
		      WHERE i.indrelid = c.conrelid
		        AND i.indisvalid
		        AND i.indpred IS NULL
		        AND (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] @> c.conkey
		   )
		 ORDER BY tbl, c.conname`)
	if err != nil {
		return fmt.Errorf("自检：外键索引扫描失败: %w", err)
	}
	defer rows.Close()
	var bad []string
	for rows.Next() {
		var tbl, con, col string
		if err := rows.Scan(&tbl, &con, &col); err != nil {
			return err
		}
		bad = append(bad, fmt.Sprintf("%s.%s(%s)", tbl, con, col))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(bad) > 0 {
		return fmt.Errorf("自检：%d 条外键没有可用索引（表.约束(列)）：%s",
			len(bad), strings.Join(bad, ", "))
	}
	return nil
}
