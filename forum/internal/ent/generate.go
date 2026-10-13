package ent

// ent 生成代码的唯一入口。改了 internal/ent/schema/ 之后跑：
//
//	go generate ./internal/ent
//
// 开关：sql/lock 是 PostgreSQL 的 FOR UPDATE / SKIP LOCKED（队列领任务要用）。
// 注意：生成代码禁止手改；表结构的唯一真源是 internal/ent/schema/。
// 特性开关：
//   sql/lock      —— FOR UPDATE / SKIP LOCKED（队列领任务）
//   sql/execquery —— *ent.Tx 上的 ExecContext / QueryContext（EnqueueTx 在业务事务里投任务要用）
// 少开任何一个都会在 app 包的 ent_tx_assert_test.go 上直接编译失败（那是它存在的意义）。
//go:generate go run -mod=mod entgo.io/ent/cmd/ent generate --feature sql/lock,sql/execquery ./schema
