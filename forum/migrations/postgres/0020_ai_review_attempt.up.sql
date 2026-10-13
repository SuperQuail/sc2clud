-- AI 审核的「试过一次」戳。没有它，被判违规的主题会**永远**占住待审窗口的前 5 名：
-- 每一轮都重新外呼同样那 5 条（烧 token），而且队列**永远推不到后面的帖子**（2026-10-14 自查出的 P0）。
--
-- NULLS FIRST + 一天冷却：新帖先审；审过的隔一天可以再审（作者改了内容能被重新看到）。
ALTER TABLE topics ADD COLUMN ai_reviewed_at timestamptz;
-- 模型的原话单独一列：review_note 是**给人看的批注**（管理员会编辑它），两个用途混一列会互相覆盖。
ALTER TABLE topics ADD COLUMN ai_review_note text;

-- 待审队列索引：过滤与排序都落在这一条上，队列长了也不会全表扫。
CREATE INDEX idx_topics_ai_review_queue ON topics (ai_reviewed_at NULLS FIRST, id)
  WHERE review_state = 'pending' AND visibility = 'normal';