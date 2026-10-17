package app

import (
	"testing"

	ent "forum/internal/ent"

	"forum/internal/platform/queue"
)

// 这条守卫的价值：*ent.Tx 要有 ExecContext，ent 生成时必须开 sql/execquery 特性
// （internal/ent/generate.go 的 --feature）。忘了开的话，EnqueueTx 在业务事务里就投不出任务。
// 放在 app 包里是因为只有这里同时看得到 ent 与 queue；它会在 go test ./... 与 go vet 时直接编译失败。
func TestEntTxSatisfiesQueueTxExecutor(t *testing.T) {
	var _ queue.TxExecutor = (*ent.Tx)(nil)
}
