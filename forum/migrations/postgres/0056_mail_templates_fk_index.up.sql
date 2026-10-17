-- 0056_mail_templates_fk_index.up.sql —— 补 0054 漏建的外键索引（2026-10-15 部署实测）。
--
-- 0054 给 updated_by 建了 FK（ON DELETE SET NULL）却没配索引：删用户时按列找行全表扫，
-- platform/db.SelfCheck 的「外键列必须有可用索引」检查在 forum run 启动时直接判死，
-- dev 站因此起不来（版本 55 = 0054+0055 都已应用，机器上手工补过同一条索引）。
-- IF NOT EXISTS：手工补过的库幂等，全新库由常规迁移补齐。
CREATE INDEX IF NOT EXISTS idx_mail_templates_updated_by ON mail_templates (updated_by);
