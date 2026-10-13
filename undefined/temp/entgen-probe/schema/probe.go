package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
)

type Probe struct{ ent.Schema }

func (Probe) Fields() []ent.Field {
	return []ent.Field{field.String("name")}
}
