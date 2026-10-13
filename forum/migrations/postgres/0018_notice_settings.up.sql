-- 0018_notice_settings.up.sql —— 两件事：
--   1) 补上 user_notice_settings（数据库设计 §4.5 / d4 §2.2 要求它，但 0001–0017 里根本没有这张表）；
--   2) 放开 mail_accounts.provider 的 CHECK，把 'log' 收进来（见文件末尾的理由）。

-- ============================================================
-- 1) user_notice_settings：一行一人，消息设置页的四项
-- ============================================================
-- 列照 d4 §2.2 与数据库设计 §4.5；两处口径差异按拍板 §8.3 处理（见下面 reply_scope 的注释）。
--
-- 为什么补 id 并把 user_id 降为 UNIQUE：ent 实体需要单一 id 主键（_P2-修正清单 §7 第 2 类：
-- 「ent 实体有 id、迁移没这列」在写路径不报错，读路径才报 column does not exist）。
CREATE TABLE user_notice_settings (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert         boolean     NOT NULL DEFAULT true,
  reply_scope   text        NOT NULL DEFAULT 'all',
  mention_scope text        NOT NULL DEFAULT 'all',
  like_alert    boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id),   -- 原自然键：一行一人
  -- 拍板 §8.3：本产品没有「关注用户」，所以 followed 从值域里删掉。
  -- 留着它界面就会给一个假选项；而且「留着但等同 all」是最差的一种（静默不一致）。
  CONSTRAINT ck_user_notice_settings_reply_scope   CHECK (reply_scope IN ('all','none')),
  CONSTRAINT ck_user_notice_settings_mention_scope CHECK (mention_scope IN ('all','none'))
);
-- 外键列必须显式建索引（拍板 §5.9 第 6 条）：UNIQUE (user_id) 已经覆盖，不再建第二条第
-- （拍板 §5.9 第 7 条：别建重复索引）。

-- ============================================================
-- 2) mail_accounts.provider：把 'log' 收进值域
-- ============================================================
-- 0014 的 ck_mail_accounts_provider 只允许 resend / smtp。本轮给 platform/mail 补了第三个
-- provider：log（把整封信写进 slog），它让「注册 → 收码 → 激活」在零外部依赖下可跑
--（拍板 §12.6 的验收要的正是这条）。
--
-- 没有把 log 做成**不是账号**的旁路：那样「有没有可用发信账号」就有两套判定
--（配置里一个开关 + mail_accounts 一张表），而拍板 §12.2 已经把这件事钉成一句话——
-- 「auto_activate=true 但没有任何可用发信账号 → 注册直接 503 auth.mail_unavailable」。
-- 让它就是一个普通账号，那条判定仍然只在 platform/mail.Router.accounts() 里写一遍。
--
-- 【安全】log provider 会把正文（含 6 位验证码）写进日志，**只能配在 dev / 测试环境**；
-- 生产库里出现 provider='log' 的账号 = 把验证码写进日志。
ALTER TABLE mail_accounts DROP CONSTRAINT ck_mail_accounts_provider;
ALTER TABLE mail_accounts ADD CONSTRAINT ck_mail_accounts_provider
  CHECK (provider IN ('resend','smtp','log'));
