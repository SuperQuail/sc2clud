-- 0054_mail_templates.up.sql —— 邮件模板后台可编辑（D37，2026-10-15 用户拍板）。
--
-- 语义：缺行 = 用 go:embed 内置模板（platform/mail.Render 零变化），
-- 所以**不迁移任何初始数据** —— 表建空的那一刻，四个模板就都在内置那几份上。
-- 只有管理员真的保存过一次（PUT）才插行；「恢复内置」= DELETE：下一封信重新落回内置。
--
-- 存的是**模板源码**（subject/html_body/text_body 三段），不是渲染结果：
-- 转义永远发生在渲染时的 Data 注入（v2 §8.5 的安全语义与表无关）。
CREATE TABLE mail_templates (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ent 实体必须有 id（0014 同款）；kind 才是业务键
  kind       varchar(64) NOT NULL UNIQUE,
  subject    text        NOT NULL,
  html_body  text        NOT NULL,
  text_body  text        NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by bigint      NULL REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_mail_templates_kind CHECK (kind IN ('verify_email','reset_password','test','notice'))
);
-- kind 主键首列 → 按模板读行就是主键查找，不再补单列索引（拍板 §5.9 第 7 条）。
