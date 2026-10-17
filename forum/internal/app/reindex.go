package app

import (
	"context"
	"encoding/json"
	"fmt"

	"forum/internal/config"
	"forum/internal/ent/topic"
)

// Reindex 把 topic_search 重建成「可见且已通过」的主题应有的样子。
//
// 为什么必须有这个入口（2026-10-13）：topic_search 是**派生表** —— 它只在 forum 的写路径上
// （CreateTopic / UpdateTopic 的事务里入队 search:index，worker 消费时写）才长出行来。
// 任何**绕过写路径**的写入都不会有索引：数据导入、迁移、直接改库、索引损坏 ——
// 而在此之前**没有任何重建入口**。实测后果：迁移进来的 4 篇老帖在搜索里一条都搜不到
// （搜「弥音」→ 0 条），而它们都是 normal/approved。
//
// 幂等且可重复执行：它按主题 id 重算文档并 upsert，跑第二遍结果相同。
func Reindex(ctx context.Context, cfg *config.Config) error {
	log, err := newLogger(cfg.Log)
	if err != nil {
		return err
	}
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer in.Close()

	m, err := newModules(ctx, cfg, in)
	if err != nil {
		return err
	}

	// 口径与写路径的入队一致：只有可见且已通过的主题才进索引。
	// （pending / rejected / deleted 不进 —— 否则搜索会把没通过的帖子漏出去。）
	ids, err := in.DB.Topic.Query().
		Where(topic.VisibilityEQ("normal"), topic.ReviewStateEQ("approved")).
		IDs(ctx)
	if err != nil {
		return fmt.Errorf("reindex: 取主题列表: %w", err)
	}

	for _, id := range ids {
		payload, err := json.Marshal(map[string]int64{"id": id})
		if err != nil {
			return err
		}
		// 与 worker 消费 search:index 时调的是同一个函数 —— 复用写路径，不另写一份索引算法。
		if err := m.indexTopic(ctx, payload); err != nil {
			return fmt.Errorf("reindex: 主题 %d: %w", id, err)
		}
	}
	fmt.Printf("reindex: ok, topics=%d\n", len(ids))
	return nil
}
