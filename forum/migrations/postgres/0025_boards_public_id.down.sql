-- 0025_boards_public_id 的回滚：整列删掉（本迁移没有改动别的表）。
-- 注意：回滚会丢掉对外 ID，任何已经发给前端的分区 id 都会失效 ——
-- 这正是「迁移之后不允许回滚旧二进制」的一个具体例子（交接单 §4.E5 / K2）。
ALTER TABLE boards DROP CONSTRAINT IF EXISTS uq_boards_public_id;
ALTER TABLE boards DROP COLUMN IF EXISTS public_id;
