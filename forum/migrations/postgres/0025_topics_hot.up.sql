-- 0025_topics_hot：最热排序的落点（拍板 08 · L2）。
--
-- 排序口径（用户原话）：score = (like_count + 3 * 顶层评论数) * time_boost，
-- time_boost = 1.5 当互动在**一周内**，否则 1.0；评论**不含楼中楼**。
-- 表达式只有一份实现：forum/internal/forum/pgsql/topics.go 的 hotScoreSQL。
--
-- 为什么非要这一列：score 里没有时间列可当游标键 —— 原来的游标是
-- `(排序列, id) < ($k::timestamptz, $id::bigint)`，而「一周内」的判据必须有**稳定**的落点。
-- 用 posts/likes 的 max(created_at) 现算要扫三张表，而且点赞一撤就变；
-- 落一列 last_interaction_at（**只单调前进**）则让分数在同一秒内可重算、可比较、可进游标。
--
-- 维护点（三处写路径，漏一处分数就会停在过去）：
--   · posts 的 InsertPost / DeletePostRow → RecountTopic（末尾那句 GREATEST）
--   · likes 的 Vote / Unvote（点赞与取消都重算；取消是复算不是回退，见 pgsql/votes.go）
-- 初始值 = GREATEST(created_at, last_reply_at, 最后一次点赞时间)：
-- 老数据的「最近互动」只能从这三处反推（1 楼就是 last_reply_at 的兜底）。

ALTER TABLE topics ADD COLUMN last_interaction_at timestamptz NOT NULL DEFAULT now();

UPDATE topics t
   SET last_interaction_at = GREATEST(
         t.created_at,
         t.last_reply_at,
         COALESCE((SELECT max(l.updated_at) FROM likes l
                    WHERE l.target_type = 'topic' AND l.target_id = t.id),
                  'epoch'::timestamptz),
         COALESCE((SELECT max(l.updated_at) FROM likes l
                    WHERE l.target_type = 'post'
                      AND l.target_id IN (SELECT p.id FROM posts p WHERE p.topic_id = t.id)),
                  'epoch'::timestamptz));

-- 按互动时间取一段候选（归档 / 清理也用它）。
-- **它不直接服务 ORDER BY score DESC** —— score 依赖 now()，不可能进索引表达式；
-- 排序由查询在做完候选之后完成（主题量级万级，一页 20 条）。
CREATE INDEX idx_topics_hot ON topics (last_interaction_at DESC, id DESC)
  WHERE visibility = 'normal';
