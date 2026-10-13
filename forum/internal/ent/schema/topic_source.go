package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"

	"forum/internal/ent/schema/mixin"
)

// TopicSource 资源帖下载源（d3-forum.md §2.1/§2.2、§7；表 topic_sources）。
// 2026-10-12 需求变更（拍板 §8.10）：展示形态是「一排网站 logo 按钮」，
// 所以 provider 是**开放小集合**（图标不存库，前端按 key 查、查不到回落通用图标）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_topic_sources_provider / ck_topic_sources_url (url ~ '^https?://') /
//     ck_topic_sources_upkeep / ck_topic_sources_size / ck_topic_sources_code / ck_topic_sources_go_count；
//   - fk_topic_sources_topic → topics(id) CASCADE。
//
// 【迁移 0004 漏了一行】topic_sources.public_id：d3 §12.1 第 8 条与 §3.7 Q7c 都要它（转链端点
// GET /topics/{id}/sources/{sid}/go 按它寻址，拍板 §5.6 禁止把自增 id 返给前端），但 0004_forum 的
// DDL 里没有这一列。本 schema 按设计保留它 —— 请迁移作者补上，否则 ent 侧查这一列会报错（未决）。
type TopicSource struct {
	ent.Schema
}

func (TopicSource) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

func (TopicSource) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("topic_id"),
		field.String("provider").MaxLen(24).SchemaType(pgType("varchar(24)")).
			Comment("已知 13 个 key（baidu/aliyun/quark/lanzou/pan123/weiyun/onedrive/mega/website/github/gitee/other），CHECK 在迁移"),
		field.String("label").MaxLen(60).SchemaType(pgType("varchar(60)")).Default("").
			Comment("作者写的显示名"),
		field.String("url").SchemaType(pgType("text")).Comment("外部直链；CHECK 只兜住「不是 http(s)」，没有域名白名单"),
		field.String("extraction_code").MaxLen(16).SchemaType(pgType("varchar(16)")).Optional().Nillable().
			Comment("网盘提取码，**明文存**：它是给所有人看的分享口令，不是密码"),
		field.String("size_text").MaxLen(16).SchemaType(pgType("varchar(16)")).Default("").
			Comment("展示用「2.4 GB」，后端格式化后端存（前端不做单位换算）"),
		field.String("upkeep").SchemaType(pgType("text")).Default("active").
			Comment("active/archived。**不许从 verified_at 推断**：链接昨天验过、作者已弃坑是常见组合"),
		field.Int64("go_count").Default(0).Comment("转链点击数；本域唯一走 counter 缓冲的计数列"),
		field.Time("verified_at").Optional().Nillable().
			Comment("作者最后一次「我确认这条还有效」的时间"),
		field.Int32("sort").Default(0),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (TopicSource) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("topic", Topic.Type).Field("topic_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

func (TopicSource) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("topic_id", "sort", "id").StorageKey("idx_topic_sources_topic"),
	}
}
