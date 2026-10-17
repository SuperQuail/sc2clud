-- ============================================================
-- 0021 通知记录发起者：点赞/审核等通知要能显示对方头像并做累计聚合
-- 纯加法。
-- ============================================================

-- 谁触发的这条通知（点赞者、审核的管理员、提 issue 的人…）；老数据为 NULL，展示时兜底。
ALTER TABLE notifications ADD COLUMN actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- 累计聚合要按「同一条内容」分组，link 就是分组键；加个索引免得全表扫。
CREATE INDEX IF NOT EXISTS idx_notifications_user_kind_link ON notifications(user_id, kind, link);
