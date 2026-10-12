package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// RolePermission 角色 × 权限点勾选矩阵（d2-auth.md §5.6；表 role_permissions）。
//
// 纯关联表，只增不改：created_at 一个时间列。
//
// 留给手写迁移（ent 表达不了）：
//   - PRIMARY KEY (role_id, permission_id) —— 主键已覆盖 role_id 侧的级联扫描
//   - idx_role_permissions_permission (permission_id)
//     —— 复合主键的第二列**不算已索引**（拍板 §5.9 第 6 条），删权限点要扫它，
//     漏了会被数据库文档 §12 第 1 条的自检判红
//
// 这里声明的 (role_id, permission_id) 唯一索引与主键同形：ent 没有「声明主键」的表达，
// 两张 DDL 路径靠它对齐（迁移里落地成 PRIMARY KEY）。
type RolePermission struct {
	ent.Schema
}

// Fields 见 d2-auth.md §5.6。
func (RolePermission) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("role_id"),
		field.Int64("permission_id"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：两侧 CASCADE（删角色/删权限点都让勾选行消失）。
func (RolePermission) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("role", Role.Type).Field("role_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("permission", Permission.Type).Field("permission_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：复合主键（迁移落地为主键）+ permission_id 单列外键索引。
func (RolePermission) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("role_id", "permission_id").Unique(),
		index.Fields("permission_id").StorageKey("idx_role_permissions_permission"),
	}
}
