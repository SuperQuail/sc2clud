package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
)

// Role 角色（d2-auth.md §5.4；表 roles）。一人一个基线角色，不存在 user_roles（拍板 §1.4）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_roles_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
//   - ck_roles_depth_nonneg   CHECK (depth >= 0)
//   - uq_roles_super          UNIQUE (is_super) WHERE is_super
//     —— 「全库最多一个超管角色」的结构性保证，authz 的超管短路靠它（拍板 U3：不许比较 role.key）
//     —— 部分索引谓词只引用列，合法；不带任何时间比较（拍板 §5.9 第 1 条）
//   - idx_roles_parent        (parent_id) —— 纯外键索引（ON DELETE RESTRICT 同样要扫）
//   - key 的唯一约束由 field.Unique() 生成
//
// depth 不加「≤3」这类上界 CHECK：移动父节点时中间态会违反它，值域由 service 保证；
// 层级只在自定义角色上用（四个内置角色的 parent_id 全是 NULL），读时闭包，不写穿（拍板 U8）。
//
// 数据（0017_seed_authz）：4 个内置角色 + 24 个权限点；矩阵是 user 3 / creator 7 /
// admin 16 / superadmin 24，与 d2 §8.6 的表差在 topic.feature（seed 无）与 resource.publish
// （seed 只给 creator）两项——见 Permission 的注释与回报的「不一致」清单。
type Role struct {
	ent.Schema
}

// Fields 见 d2-auth.md §5.4。
func (Role) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("key").MaxLen(32).Unique().
			Immutable().
			Comment("机器名（user/creator/admin/superadmin 或自定义），授权判定只用它以外的数据"),
		field.String("name").MaxLen(32).
			Comment("后台展示名"),
		field.String("description").MaxLen(200).Default(""),
		field.Int64("parent_id").Optional().Nillable().
			Comment("父角色（层级只给自定义角色用）；FK roles(id) ON DELETE RESTRICT"),
		field.Int("depth").Default(0).
			Comment("写入时算并存（拍板 U18）；CHECK (depth >= 0) 在迁移"),
		field.String("badge_color").MaxLen(16).Optional().Nillable(),
		field.Bool("is_system").Default(false).
			Comment("内置角色（矩阵可改，角色本身不可删）"),
		field.Bool("is_super").Default(false).
			Comment("超管短路的数据来源；全局最多一个 true，由 uq_roles_super 保证"),
		field.Int("priority").Default(0).
			Comment("**只用于后台展示排序，禁止用于授权判断**（数据库文档 §4.1）"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：自引用层级（RESTRICT）+ 两条被引用边（users.role_id 与 role_permissions）。
func (Role) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("parent", Role.Type).Field("parent_id").Unique().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.From("users", User.Type).Ref("role"),
		edge.From("role_permissions", RolePermission.Type).Ref("role"),
	}
}
