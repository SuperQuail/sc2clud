DROP INDEX IF EXISTS idx_topics_ai_queue;
DROP TABLE IF EXISTS review_events;
ALTER TABLE topics DROP CONSTRAINT IF EXISTS ck_topics_review_source;
ALTER TABLE topics DROP COLUMN IF EXISTS review_source;
DROP TABLE IF EXISTS ai_config;