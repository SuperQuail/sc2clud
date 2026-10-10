-- ============================================================
-- 0029 AI 审核：举报表 + AI 审核记录 + AI 配置与提示词的默认值
-- ============================================================

-- 举报（本次只做后端，前端后续接）
CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_kind TEXT    NOT NULL,          -- post | comment
    target_id   INTEGER NOT NULL,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason      TEXT    NOT NULL DEFAULT '',
    state       TEXT    NOT NULL DEFAULT 'open',  -- open | ai_reviewed | handled | dismissed
    created_at  INTEGER NOT NULL,
    handled_at  INTEGER,
    handled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_kind, target_id, state);

-- AI 每次审核的留痕：谁触发的、发了什么、AI 回了什么、最后怎么判
CREATE TABLE IF NOT EXISTS ai_reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    target_kind   TEXT    NOT NULL,
    target_id     INTEGER NOT NULL,
    source        TEXT    NOT NULL,        -- new_post | report | manual
    verdict       TEXT    NOT NULL,        -- approve | pending | reject
    reason        TEXT    NOT NULL DEFAULT '',
    raw_response  TEXT    NOT NULL DEFAULT '',
    model         TEXT    NOT NULL DEFAULT '',
    ok            INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_target ON ai_reviews(target_kind, target_id, created_at DESC);

-- AI 配置与提示词：超管可在后台改（API key 明文存库，单机自建站可接受，展示时打码）
INSERT OR IGNORE INTO site_texts (key, value, updated_at) VALUES
    ('ai_enabled', '0', strftime('%s','now')),
    ('ai_endpoint', 'https://api.openai.com/v1', strftime('%s','now')),
    ('ai_api_key', '', strftime('%s','now')),
    ('ai_model', 'gpt-4o-mini', strftime('%s','now')),
    ('ai_prompt_new_post', '你是中型星际争霸 II 社区的内容审核员。判断下面这条帖子是否合规：广告与引流、来源不明的可执行文件、侵权转载、人身攻击等属于明确违规；信息不足、边界情况一律给待定，交人工复核。', strftime('%s','now')),
    ('ai_prompt_report', '你是社区内容审核员。下面这条内容被用户举报，请重新判定它是否违规：明确违规才给不通过，拿不准就给待定。', strftime('%s','now')),
    ('ai_review_comments', '0', strftime('%s','now')),
    ('ai_review_on_report', '1', strftime('%s','now'));
