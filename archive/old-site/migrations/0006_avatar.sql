-- ============================================================
-- 0006 用户头像
--
-- 头像由**浏览器侧**裁剪并压到 ≤64KB 后上传，服务端只存结果。
-- 复用内容寻址存储：同一张头像被多个账号用也只落一份盘。
-- ============================================================

ALTER TABLE users ADD COLUMN avatar_hash TEXT;
-- 头像的 MIME 一起存：读取时要靠它给出 Content-Type（blob 文件名是哈希）
ALTER TABLE users ADD COLUMN avatar_mime TEXT;
CREATE INDEX idx_users_avatar ON users(avatar_hash);
