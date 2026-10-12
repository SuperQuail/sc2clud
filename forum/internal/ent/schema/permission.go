package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
)

// Permission 权限点（d2-auth.md §5.5；表 permissions）。
//
// 24 个权限点**只能由迁移写入**（拍板 §1.2 冻结，方案与拍板都禁止后台新增权限点）：
// key 的集合必须等于 internal/authz/permissions.go 的常量集合（D2 §14.1 启动自检）。
//
// 已落地的 0017_seed_authz 取的是**拍板 §1.2 的 24 行**（topic.pin 管「置顶 / 精华」，
// 并按 U1/U2 补 resource.publish），不是 d2 §8.6 那份（它把 topic.feature 单列）。
// 两份都是 24 个但集合差两个 key，授权矩阵因此也不同（creator 7、admin 16）——
// 这是 seed 作者与 D2 的实质分歧，已报 Lead，schema 侧不受影响（本表只有 key 唯一约束）。
//
// 列名是 grp 不是 group：group 是 SQL 保留字，每次引用都要加引号。
//
// 留给手写迁移：key 的唯一约束由 field.Unique() 生成；本表没有别的手写对象，也没有外键。
type Permission struct {
	ent.Schema
}

// Fields 见 d2-auth.md §5.5。
func (Permission) Fields() []ent.Field {
	return []ent.Field{
		field.String("key").MaxLen(64).Unique().
			Immutable().
			Comment("权限点 key，如 topic.create；与 Go 常量逐字同名"),
		field.String("grp").MaxLen(32).
			Comment("后台勾选界面分组：topic/board/user/title/site"),
		field.String("name").MaxLen(32).
			Comment("中文名（后台标签）"),
		field.String("description").MaxLen(200).Default(""),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：两条被引用边（role_permissions 与 user_permissions 都必须能级联删）。
func (Permission) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("role_permissions", RolePermission.Type).Ref("permission"),
		edge.From("user_permissions", UserPermission.Type).Ref("permission"),
	}
}
