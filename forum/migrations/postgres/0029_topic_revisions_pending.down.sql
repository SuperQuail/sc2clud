-- 0029 的回滚：丢掉待审版本那两列（线上版本 content_md 一个字不动 ——
-- 回滚之后作者的改动仍然是「写进 posts」，与 0028 时的行为一致）。
ALTER TABLE topic_revisions DROP CONSTRAINT IF EXISTS ck_topic_revisions_pending;
ALTER TABLE topic_revisions DROP COLUMN IF EXISTS pending_at;
ALTER TABLE topic_revisions DROP COLUMN IF EXISTS pending_html;
ALTER TABLE topic_revisions DROP COLUMN IF EXISTS pending_md;
