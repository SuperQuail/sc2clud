-- 0010_media down：先撤 0010 给 users 补的列与索引，再删本文件的表。
DROP INDEX idx_users_default_avatar;
ALTER TABLE users DROP COLUMN default_avatar_hash;
DROP TABLE payment_channels;
