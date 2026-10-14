-- 0040_follows：关注（分区 / 用户）—— 拍板 L5（2026-10-14）
--
-- 依据：完全重构/进行中/08-拍板记录.md 的 L5「实现关注功能,但是暂时不需要做关注后的推送,算备用」。
-- 这一条**推翻**了 完全重构/后端开工前拍板.md §8.3 与 d3-forum.md §3.3 的「本产品没有关注关系」：
-- 分区页设计稿（完全重构/设计需求-分区页.md §A）要的「关注 / 取消关注」与「成员/关注数」于是有了承载。
--
-- 三处口径写死在这里，别处不许各推一套：
--   1. 两种对象在**一张表**里（user_id / board_id 二选一）。分成两张表的话，「我关注了什么」这一问
--      要 UNION 两遍，而两个列表页、两个统计、两套幂等就会各写一份 —— 它们本来就是同一件事。
--   2. **幂等 = 唯一索引 + ON CONFLICT DO NOTHING**，不是「先查后插」：并发重放时后者两条都会插进去，
--      而幂等是端点承诺的一部分（与 uq_appeals_topic_pending / uq_reports_once 同一个取舍）。
--   3. **计数现算，不落计数列**（与 boards 的 topic_count 同一个口径，d3-forum §3.3 Q2e）：
--      索引扫得出、少一处会被写漏的冗余。
--
-- 关注**不产生通知**（拍板：暂时不需要，算备用）。所以这里没有 notify:* 任务类型，也没有通知类别。

CREATE TABLE follows (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  follower_id bigint      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  -- 二选一：两个都可空，但**恰好一个非空**（ck_follows_target）。CASCADE 而不是 SET NULL ——
  -- 被关注的对象没了，这条关注就没有意义，留一行 NULL 只会让计数与列表各自去猜。
  user_id     bigint      NULL     REFERENCES users(id)  ON DELETE CASCADE,
  board_id    bigint      NULL     REFERENCES boards(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 「不能关注自己」在 service 里判（要回 400，不是 500）；这条是数据库侧的兜底。
  CONSTRAINT ck_follows_target CHECK (
    (user_id IS NOT NULL AND board_id IS NULL) OR
    (user_id IS NULL AND board_id IS NOT NULL)),
  CONSTRAINT ck_follows_self   CHECK (user_id IS NULL OR user_id <> follower_id)
);

-- 幂等落点。两条**部分**唯一索引，而不是一条带 COALESCE 的唯一索引：
-- 部分索引是谓词精确匹配的，查询侧写同样的 WHERE 就会用到它（EXPLAIN 可验）。
CREATE UNIQUE INDEX uq_follows_user  ON follows (follower_id, user_id)  WHERE user_id  IS NOT NULL;
CREATE UNIQUE INDEX uq_follows_board ON follows (follower_id, board_id) WHERE board_id IS NOT NULL;

-- 粉丝列表（谁的关注者）：按时间倒序的游标分页。
CREATE INDEX idx_follows_user_followers  ON follows (user_id,  created_at DESC, id DESC);
CREATE INDEX idx_follows_board_followers ON follows (board_id, created_at DESC, id DESC);
-- 「我关注的人 / 我关注的分区」两个列表页。
CREATE INDEX idx_follows_follower_user   ON follows (follower_id, created_at DESC, id DESC) WHERE user_id  IS NOT NULL;
CREATE INDEX idx_follows_follower_board  ON follows (follower_id, created_at DESC, id DESC) WHERE board_id IS NOT NULL;
-- 外键列的非部分索引：platform/db 的启动自检要求「每个外键列上有一条**非部分**索引」
-- （selfcheck.go 的 indpred IS NULL 那条：RI 查找用不了部分索引，会被误判成已覆盖），少了拒绝启动。
-- 上面那几条都是部分索引，一个都不算数 —— 这三条必须单独建。
CREATE INDEX idx_follows_follower ON follows (follower_id);
CREATE INDEX idx_follows_user     ON follows (user_id);
CREATE INDEX idx_follows_board    ON follows (board_id);
