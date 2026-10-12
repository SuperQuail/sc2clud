package ent

// ent 生成代码的唯一入口。改了 internal/ent/schema/ 之后跑：
//
//	go generate ./internal/ent
//
// 开关：sql/lock 是 PostgreSQL 的 FOR UPDATE / SKIP LOCKED（队列领任务要用）。
// 注意：生成代码禁止手改；表结构的唯一真源是 internal/ent/schema/。
//go:generate go run -mod=mod entgo.io/ent/cmd/ent generate --feature sql/lock ./schema
