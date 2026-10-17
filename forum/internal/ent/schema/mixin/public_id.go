package mixin

import (
	"github.com/google/uuid"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/mixin"
)

// PublicID 给表加对外 ID（数据库文档 §2 第 3 条）。
// 值由**应用**用 UUID v7 生成（platform/idgen），**不设默认值**——不依赖 PG 是否自带 uuidv7()。
// 只有「会被 URL / API 直接寻址」的表才加它；纯关联表（likes、topic_images…）不加。
type PublicID struct{ mixin.Schema }

func (PublicID) Fields() []ent.Field {
	return []ent.Field{
		field.UUID("public_id", uuid.UUID{}).Unique().Immutable().
			Comment("对外 ID（UUID v7，应用生成）；API 只出现它，禁止暴露自增 id"),
	}
}
