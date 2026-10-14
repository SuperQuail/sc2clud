DROP TABLE IF EXISTS ai_reviews;
DROP INDEX IF EXISTS idx_topics_ai_queue;
ALTER TABLE topics DROP COLUMN IF EXISTS ai_reviewed;