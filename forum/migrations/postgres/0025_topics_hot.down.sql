-- 0025_topics_hot 的回滚：索引与列一起删（本迁移没动别的表）。
DROP INDEX IF EXISTS idx_topics_hot;
ALTER TABLE topics DROP COLUMN IF EXISTS last_interaction_at;
