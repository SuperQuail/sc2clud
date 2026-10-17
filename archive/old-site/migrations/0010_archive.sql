-- ============================================================
-- 0010 帖子归档
--
-- 归档 = 不删除、不再展示：`archived_at` 非空即从所有列表里消失，
-- 但管理员/作者仍可通过直链打开（带「已归档」标记）。
-- ============================================================

ALTER TABLE posts ADD COLUMN archived_at INTEGER;
CREATE INDEX idx_posts_archived ON posts(archived_at, created_at DESC);
