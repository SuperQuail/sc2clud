-- 0009_title down：先撤本文件给 users 补的外键与索引，再逆序删表。
DROP INDEX idx_users_nickname_lower;
DROP INDEX idx_users_equipped_title;
ALTER TABLE users DROP CONSTRAINT fk_users_equipped_title;
DROP TABLE exp_events;
DROP TABLE user_titles;
DROP TABLE titles;
