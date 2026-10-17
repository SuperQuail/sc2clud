-- ============================================================
-- 0020 站点文本：超管可改的默认文案（先放「默认个人简介」）
-- 纯加法。
-- ============================================================

CREATE TABLE IF NOT EXISTS site_texts (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- 没写简介时显示这句；超管可在后台改
INSERT OR IGNORE INTO site_texts (key, value, updated_at, updated_by)
VALUES ('default_bio', '该用户很懒，没有写简介', strftime('%s','now'), NULL);
