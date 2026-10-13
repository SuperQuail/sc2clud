-- 0018_notice_settings.down.sql —— 逆序回滚

-- user_notice_settings：整张表是本轮新建的，直接删。
DROP TABLE user_notice_settings;

-- mail_accounts.provider 的值域收回去之前必须先清掉 log 行：
-- 否则 ADD CONSTRAINT 会因为已有数据而失败，回滚卡在「迁移没成功、约束也没恢复」的中间态。
-- 代价写在这里：回滚会删掉 log 账号的配置（它本来就只是 dev / 测试用的投递方式）。
DELETE FROM mail_accounts WHERE provider = 'log';
ALTER TABLE mail_accounts DROP CONSTRAINT ck_mail_accounts_provider;
ALTER TABLE mail_accounts ADD CONSTRAINT ck_mail_accounts_provider
  CHECK (provider IN ('resend','smtp'));
