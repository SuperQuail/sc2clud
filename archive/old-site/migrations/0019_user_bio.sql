-- ============================================================
-- 0019 个人简介：200 字上限，改动走审核态（当前自动放行）
-- 纯加法。
-- ============================================================

ALTER TABLE users ADD COLUMN bio               TEXT NOT NULL DEFAULT '';
-- approved / pending / rejected：现在是写入即 approved（自动放行），
-- 列先建好，等审核机接上个人简介后不用再迁移。
ALTER TABLE users ADD COLUMN bio_review_state  TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE users ADD COLUMN bio_review_note   TEXT;
ALTER TABLE users ADD COLUMN bio_updated_at    INTEGER;
