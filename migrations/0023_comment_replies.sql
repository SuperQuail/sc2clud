-- ============================================================
-- 0023 回复楼中楼（一级）：B 站式「回复某人」需要知道自己挂在谁的下面
-- 纯加法。
-- ============================================================

ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;

-- 楼中楼按父楼层聚合展示
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
