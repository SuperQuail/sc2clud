-- 0028_topic_revisions 的回滚：删表 + 把第四态的行退回 rejected + 恢复三值 CHECK。
-- **先改数据再上约束**：留着 revision_requested 的行会让 ADD CONSTRAINT 失败，
-- 而回滚失败会卡住整条上线路径。退回 rejected 是刻意的语义选择（打回更接近「没过」）。
-- verdict 先把第四态的行退回 reject 再收窄值域（同 review_state 的理由：回滚不能卡住）。
UPDATE review_events SET verdict = 'reject' WHERE verdict = 'revision_requested';
ALTER TABLE review_events DROP CONSTRAINT IF EXISTS ck_review_events_verdict;
ALTER TABLE review_events ADD CONSTRAINT ck_review_events_verdict
  CHECK (verdict IN ('approve', 'reject', 'review'));

DROP TABLE IF EXISTS topic_revisions;
DROP INDEX IF EXISTS idx_topics_review_state;
UPDATE topics SET review_state = 'rejected' WHERE review_state = 'revision_requested';
ALTER TABLE topics DROP CONSTRAINT IF EXISTS ck_topics_review_state;
ALTER TABLE topics ADD CONSTRAINT ck_topics_review_state
  CHECK (review_state IN ('pending', 'approved', 'rejected'));
