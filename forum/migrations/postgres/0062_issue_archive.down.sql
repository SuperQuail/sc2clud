-- 0062 的回滚。
--
-- **必须先删掉 target_type='issue' 的举报行**，才能还原 0006 的三值约束
--（照 0060 的先例：ADD CONSTRAINT 会被既有行顶成 23514，回滚卡在半路）。
-- 为什么删行而不是改写：值域里没有别的值能表达「举报的是一条 Issue」——
-- 改写成 topic / post 都是**伪造事实**（那条举报不是举报主题，也不是举报楼层）。
-- 删掉的是「Issue 被举报过」这条记录本身；它引用的是归档功能，而归档功能正是这次回滚要撤掉的。
-- review_events 里 issue_id 非空的行由下面的 DROP COLUMN 直接带走（列没了，判定行也就没了）。
DELETE FROM reports WHERE target_type = 'issue';

-- ③ review_events 反向：先拆「恰好一个非空」，再删列、还原 topic_id 的 NOT NULL。
--
-- **必须先删掉 issue_id 的判定行**（照 0060 的先例：ADD/SET NOT NULL 会被既有行顶成 23502，
-- 回滚卡在半路）。它们正是这次回滚要撤掉的那条链路留下的 ——
-- up 之前不存在「只判 Issue」的事件，所以删掉它们不丢任何旧数据。
-- 先断言再删：这条断言**不是永远为真的形式**（谓词恰好是待删的那批行），
-- 一个带数据的库上它会真的执行到。
-- 删行而不是改写：topic_id 那一列是「判的是哪篇主题」的指针，而这些事件的判定对象是一条 Issue，
-- 填一个主题 id 进去等于**伪造事实**（AI 判的从来不是那篇主题）。
DELETE FROM review_events WHERE issue_id IS NOT NULL;
ALTER TABLE review_events DROP CONSTRAINT ck_review_events_subject;
DROP INDEX idx_review_events_issue;
ALTER TABLE review_events DROP COLUMN issue_id;
-- 此时剩下的行必然都带 topic_id，还原 NOT NULL 不会撞既有行。
ALTER TABLE review_events ALTER COLUMN topic_id SET NOT NULL;

-- ② post_issues 反向
DROP INDEX idx_post_issues_global_unarchived;
DROP INDEX idx_post_issues_archived_by;
ALTER TABLE post_issues
  DROP COLUMN archived_at,
  DROP COLUMN archived_by,
  DROP COLUMN archive_reason;

-- ① reports 反向
ALTER TABLE reports DROP CONSTRAINT ck_reports_target_type;
ALTER TABLE reports ADD CONSTRAINT ck_reports_target_type
  CHECK (target_type IN ('topic','post','user'));
