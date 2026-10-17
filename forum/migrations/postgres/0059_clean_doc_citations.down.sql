-- 0059 的回滚：把原引注写回去。
-- 同样只在值逐字等于本迁移写出去的串时命中，重跑第二次 0 行。
UPDATE permissions
   SET description = '置顶 / 精华（两个端点共用这一个权限点，v2 §21.2）'
 WHERE key = 'topic.pin'
   AND description = '置顶 / 精华（两个端点共用这一个权限点）';
