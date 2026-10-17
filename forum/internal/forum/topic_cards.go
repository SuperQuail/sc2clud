package forum

import (
	"context"

	"forum/internal/forum/pgsql"
)

// TopicCards 按内部 id 取一批卡片，**返回顺序与传入 ids 一致**。
//
// 搜索只回答「哪些主题命中了 + 排第几」（platform/search 的 Hit：TopicID/PublicID/Title/Rank），
// 作者、分区、计数这些展示字段要按 id 补 —— 这是 d5 §6.6 的分工。
//
// shortcut: 一次一个 id 地取（一页 ≤20 次查询）。要提吞吐就换成一条 IN 查询；
// 在那之前先别加：搜索每页 20 条、每条约 1ms。
func (s *Service) TopicCards(ctx context.Context, ids []int64) ([]TopicCardDTO, error) {
	out := make([]TopicCardDTO, 0, len(ids))
	for _, id := range ids {
		row, err := s.repo.TopicCard(ctx, id)
		if err != nil {
			// 索引是**异步**写的：命中里可能有刚被删掉、或刚被改成隐藏/待审的主题。
			// 这种情况跳过这一条，别让整页搜索失败。
			if err == pgsql.ErrNoRows {
				continue
			}
			return nil, err
		}
		out = append(out, s.topicCard(*row))
	}
	return out, nil
}
