-- D71 那类缺陷的残留修复：1 楼（主题正文）曾被当成评论渲染，作者在评论区点「删除」后
-- 它被软删成 visibility = 'deleted'（DeletePostRow），此后**没有任何路径能恢复** ——
-- 读者永远看到「正文已被作者删除」，作者重新写正文也改不动（编辑只写 content_md，visibility
-- 停在 deleted）。这也是「已经手动通过的帖子编辑，帖子页面不更新」的实证来源。
--
-- 只修「帖子本身还在、只有正文行被软删」这种残留：整帖被删（topics.visibility <> 'normal'）
-- 的行不动 —— 那是删帖这个动作的结果，恢复正文等于把删掉的帖子开一半。
UPDATE posts p
   SET visibility = 'normal', updated_at = now()
  FROM topics t
 WHERE t.id = p.topic_id
   AND p.floor = 1
   AND p.visibility = 'deleted'
   AND t.visibility = 'normal';