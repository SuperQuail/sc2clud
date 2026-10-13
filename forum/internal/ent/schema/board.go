package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// pgType 覆盖 ent 在 PG 上的默认列类型。
// ent 把 field.String 一律生成为**无长度** varchar（MaxLen 只做 Go 侧校验，不落 DDL），
// 而 DDL 真源要求「有业务上限的文本用 varchar(n)、正文用 text」（数据库设计 §2 第 13 条）。
// 所以有长度的列写成 MaxLen + pgType 两份；两者不一致时以 pgType（= 库里的类型）为准。
// 本包共用一个：不要写 entsql.Annotation{Type: ...}，那个字段不存在（编译不过）。
func pgType(t string) map[string]string { return map[string]string{dialect.Postgres: t} }

// Board 分区（d3-forum.md §2.1；表 boards；迁移 0004_forum）。表驱动：新增分区零代码改动。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_boards_status / ck_boards_min_post_level（迁移已写）；
//   - fk_boards_cover FK (cover_hash) → images(hash) ON DELETE SET NULL：
//     目标不是 images 的 ent ID（images.hash 是 text，不是那个自增 id），所以 schema 里不建边。
type Board struct {
	ent.Schema
}

// Fields 见 d3-forum.md §2.1/§2.2。
func (Board) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("slug").MaxLen(32).SchemaType(pgType("varchar(32)")).Unique().
			Comment("URL 标识（/b/mod）。不可改：改 slug 等于废掉所有外链"),
		field.String("name").MaxLen(32).SchemaType(pgType("varchar(32)")),
		field.String("description").MaxLen(200).SchemaType(pgType("varchar(200)")).Default(""),
		field.Int32("sort").Default(0).Comment("展示顺序，升序"),
		field.String("status").SchemaType(pgType("text")).Default("active").
			Comment("active/archived，CHECK 在迁移。archived = 不再出现在列表与发帖选择器，已存在的主题仍可读"),
		field.String("cover_hash").MaxLen(64).SchemaType(pgType("char(64)")).Optional().Nillable().
			Comment("分区封面（D5 images.hash）；FK 在迁移里（见文件头）"),
		field.Bool("acl_enabled").Default(false).
			Comment("false = 不判 ACL、登录即可发言（拍板 §1.5 第 3 步）。默认 false 是刻意的：新分区不该一上线就没人能发帖"),
		field.Int32("min_post_level").Default(0).Comment("发帖门槛（等级），0 = 不限"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (Board) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("sort", "id").StorageKey("idx_boards_sort"),  // 分区列表与切换器
		index.Fields("cover_hash").StorageKey("idx_boards_cover"), // FK：SET NULL 也要扫这一列
	}
}
