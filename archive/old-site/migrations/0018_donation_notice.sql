-- ============================================================
-- 0018 赞助提示：作者可开关/自定义文本；超管可按渠道配默认文本
-- 纯加法。
-- ============================================================

-- 打赏弹窗里那段醒目提示。默认开（提示是有用的），文本留空表示「用渠道默认」。
ALTER TABLE users ADD COLUMN donation_notice_visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN donation_notice_text    TEXT    NOT NULL DEFAULT '';

-- 超管按渠道配的默认提示文本（渠道名与 payment_channels.channel 同一套自由文本）。
CREATE TABLE IF NOT EXISTS donation_notice_defaults (
    channel    TEXT PRIMARY KEY,
    text       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
