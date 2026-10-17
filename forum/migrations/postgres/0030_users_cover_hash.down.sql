-- 0030_users_cover_hash 的回滚：删掉封面列与它的外键索引。
DROP INDEX IF EXISTS idx_users_cover;
ALTER TABLE users DROP COLUMN IF EXISTS cover_hash;
