-- D71（用户原话「帖子正文不应该出现在评论区」）：1 楼是主题正文不是回复。
-- 历史数据里，回复 1 楼的楼层真实挂在正文名下（parent_id = 1 楼的 id）；现在
-- 「回复正文就是回复帖子」——统一改回顶层（parent_id = NULL），口径与
-- reply_count（floor > 1，pgsql.RecountTopic）一致。否则正文从评论区摘除后，
-- 这些楼就成了没有挂点的孤儿。
UPDATE posts p
   SET parent_id = NULL
 WHERE p.floor > 1
   AND p.parent_id IS NOT NULL
   AND p.parent_id = (SELECT b.id FROM posts b WHERE b.topic_id = p.topic_id AND b.floor = 1);
