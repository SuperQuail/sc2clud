DROP INDEX IF EXISTS idx_topics_ai_review_queue;
ALTER TABLE topics DROP COLUMN IF EXISTS ai_review_note;
ALTER TABLE topics DROP COLUMN IF EXISTS ai_reviewed_at;