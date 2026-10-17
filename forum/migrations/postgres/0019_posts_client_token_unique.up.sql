-- posts 的幂等键补成**部分唯一索引**。
--
-- 0004_forum.up.sql:145 建的是普通索引 `idx_posts_author_client_token`，而 ent schema（post.go:22）
-- 与 d3 设计承诺的是**部分唯一索引** `uq_posts_author_client_token`。
--
-- 为什么这不是「少了个索引」的小事：`CreatePost` 的幂等**完全押在那条索引上** ——
-- 它靠 23505 冲突回查既有行。索引不唯一 → 冲突永远不会发生 → **那段回查是死代码** →
-- 同一个请求重放（重试、双击、脚本重跑）会**重复插楼**。实测：seed 跑第二遍 posts 从 106 涨到 181。
--
-- 同一批里 topics（0004:111）与 post_issues（0005:55）的同类索引都是 UNIQUE —— 只有 posts 写错。
-- 现在启动自检也会查这件事（platform/db/selfcheck.go 的第二条 SQL），所以不会再静静地错下去。

-- 1) 去重：同一 (author_id, client_token) 只留 id 最小的那条。
--    先把引用重复行的东西指到保留的那条，再删 —— 否则子回复会被 ON DELETE SET NULL 打断嵌套、
--    点赞会指向不存在的楼层。这里没有猜：posts.parent_id 是 SET NULL、topic_images.post_id 是 CASCADE、
--    likes 只有主键没有 (target_type,target_id) 唯一约束，所以三种重指都不会撞。
CREATE TEMP TABLE dup_posts ON COMMIT DROP AS
SELECT id AS dup_id,
       first_value(id) OVER (PARTITION BY author_id, client_token ORDER BY id) AS keep_id
  FROM posts
 WHERE client_token <> '';

DELETE FROM dup_posts WHERE dup_id = keep_id;

UPDATE posts p SET parent_id = d.keep_id FROM dup_posts d WHERE p.parent_id = d.dup_id;
UPDATE topic_images t SET post_id = d.keep_id FROM dup_posts d WHERE t.post_id = d.dup_id;
UPDATE likes l SET target_id = d.keep_id FROM dup_posts d WHERE l.target_type = 'post' AND l.target_id = d.dup_id;

DELETE FROM posts p USING dup_posts d WHERE p.id = d.dup_id;

-- 2) 换成唯一索引（形状与 topics / post_issues 完全一致）
DROP INDEX IF EXISTS idx_posts_author_client_token;
CREATE UNIQUE INDEX uq_posts_author_client_token ON posts (author_id, client_token)
WHERE client_token <> '';