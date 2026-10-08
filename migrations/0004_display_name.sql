-- ============================================================
-- 0004 显示名与登录名分离
--
-- 登录名（users.handle）是**账号标识**：ASCII、唯一、用于登录，一旦注册尽量不变。
-- 显示名（users.display_name）是**对外展示的名字**：任意文字、非空、≤ 20 字符，
--   帖子与回复里显示的都是它，用户可以随时改（改它不影响登录）。
-- ============================================================

ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
-- 存量账号：显示名先跟随登录名，之后可自行修改。
UPDATE users SET display_name = handle WHERE display_name = '';
