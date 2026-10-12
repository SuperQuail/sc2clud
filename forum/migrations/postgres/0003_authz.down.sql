-- 0003_authz down：先撤 0003 给 0002 的表补的外键，再逆序删本文件的表。
ALTER TABLE images DROP CONSTRAINT fk_images_owner;
DROP INDEX idx_images_owner;
DROP TABLE board_moderators;
DROP TABLE audit_logs;
DROP TABLE user_permissions;
DROP TABLE email_tokens;
DROP TABLE sessions;
