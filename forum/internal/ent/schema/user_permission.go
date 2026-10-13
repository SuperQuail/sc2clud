package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// UserPermission 点对点追加的权限（d2-auth.md §5.7；表 user_permissions）。
//
// **user_id 故意没有指向 users 的外键**（D2 §5.7）：提权记录是审计材料，
// 不能因为删用户而消失；ON DELETE CASCADE 恰好会把它抹掉。users 永不硬删（数据库文档 §2 第 11 条），
// 所以这条「无外键」不是漏——全库外键索引自检按 pg_constraint 扫，没有外键就没有索引要求。
// 因此这里**也不声明指向 User 的边**：edge 会生成外键，与设计相反。
//
// 留给手写迁移（ent 表达不了）：
//   - PRIMARY KEY (user_id, permission_id)
//   - ck_user_permissions_expires CHECK (expires_at IS NULL OR expires_at > granted_at)
//   - ck_user_permissions_reason  CHECK (btrim(reason) <> ”)
//   - idx_user_permissions_permission (permission_id) —— 复合主键第二列 + 删权限点的级联路径
//   - idx_user_permissions_granted_by (granted_by)    —— ON DELETE SET NULL 的扫描路径
//   - **刻意不建 (user_id) 单列索引**：没有 users 外键、也没有任何按 user_id 的范围扫（D2 §5.10）
//   - **刻意不建「未过期」部分索引**：谓词要写 expires_at > now() 才成立，而 now() 不是 IMMUTABLE
//     （拍板 §5.9 第 1 条 / §9.10）。清理走全表范围扫 DELETE ... WHERE expires_at < $1 - 7d
type UserPermission struct {
	ent.Schema
}

// Fields 见 d2-auth.md §5.7。
func (UserPermission) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id").
			Comment("被授权的用户；无外键，理由见文件头"),
		field.Int64("permission_id"),
		field.Int64("granted_by").Optional().Nillable().
			Comment("授权人；FK users(id) ON DELETE SET NULL"),
		field.Time("granted_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("expires_at").Optional().Nillable().
			Comment("NULL = 永不过期；CHECK (expires_at IS NULL OR expires_at > granted_at) 在迁移"),
		field.String("reason").MaxLen(200).
			Comment("授权理由，必填非空（CHECK btrim(reason) <> ''）——提权必须留痕"),
	}
}

// Edges：权限点侧 CASCADE；granted_by 侧 SET NULL（授权人注销后提权记录仍在）。
func (UserPermission) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("permission", Permission.Type).Field("permission_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("granter", User.Type).Field("granted_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：复合主键 + 两条外键索引。
func (UserPermission) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "permission_id").Unique(),
		index.Fields("permission_id").StorageKey("idx_user_permissions_permission"),
		index.Fields("granted_by").StorageKey("idx_user_permissions_granted_by"),
	}
}
