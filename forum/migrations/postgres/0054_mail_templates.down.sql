-- 0054_mail_templates.down.sql：模板还存着就删掉 —— 内置模板不依赖这张表。
DROP TABLE IF EXISTS mail_templates;
