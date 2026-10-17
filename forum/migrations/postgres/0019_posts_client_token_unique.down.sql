-- 回退：换回 0004 那份普通索引。
-- 注意**去重不可回退** —— 被删的重复行是重放产生的垃圾，没有保留价值。
DROP INDEX IF EXISTS uq_posts_author_client_token;
CREATE INDEX idx_posts_author_client_token ON posts (author_id, client_token)
WHERE client_token <> '';