-- 补 0020 漏掉的外键索引：review_events.actor_id 建了 FK 却没建索引，
-- 启动自检（platform/db 的「外键没有可用索引」那条）据此**拒绝启动** —— 2026-10-14 实际发生过：
-- dev 升级到 schema 20 后服务起不来、nginx 502，日志只有一行「外键 ... 上没有可用索引」。
-- 自检没错，是迁移漏了。IF NOT EXISTS：线上若已手工补过，这一条是空操作。
CREATE INDEX IF NOT EXISTS idx_review_events_actor ON review_events (actor_id);