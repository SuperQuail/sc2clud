-- 0062_issue_archive：Issue 可被举报 → 到阈值交 AI 复核 → 判违规**归档**。
--
-- 三件事在这一条迁移里（它们是同一个动作的三块拼图，拆开任何一块都跑不起来）：
--   1. reports.target_type 认 'issue'（0006_social 的 ck_reports_target_type 只有 topic|post|user）——
--      没有它，举报一条 Issue 会在插入时撞 23514，界面上看起来像「举报按钮坏了」；
--   2. post_issues 的三列归档状态（`archived_at` NULL = 未归档）——**归档不是删除**：
--      正文、评论、编号全留着，只在公共读口隐身，管理后台随时能恢复；
--   3. review_events 的判定对象从「只能是主题」放宽到「主题**或** Issue」——
--      AI 判 Issue 的结论必须与主题判定落在同一张表里（审核历史屏只有一个读口），
--      而这一列原本是 NOT NULL 指向 topics 的。
--
-- 为什么用「恰好一个非空」的 CHECK 而不是加一个 target_type 列：review_events 是**判定历史**，
-- 一条判定必然针对一个具体对象；两个都可空会让「两个都空」这种没有意义的行也能写进去。

-- ============================================================
-- ① reports：值域放宽到含 issue
-- ============================================================
-- 只放宽值域，不动已有行（它们全是 topic/post/user，落得进新约束）。
ALTER TABLE reports DROP CONSTRAINT ck_reports_target_type;
ALTER TABLE reports ADD CONSTRAINT ck_reports_target_type
  CHECK (target_type IN ('topic','post','user','issue'));

-- ============================================================
-- ② post_issues：归档状态
-- ============================================================
-- archived_by 为 NULL 有两种含义，这不是缺陷：
--   · 未归档（archived_at IS NULL）时它必然是 NULL；
--   · 归档时 NULL = **AI 判的**（AI 没有 user id），非空 = 某个管理员按的。
-- 与 topics 的 review_source='ai'|'manual' 是同一件事的另一种表达。
-- ON DELETE SET NULL：删用户不该连带把「这条 Issue 被归档过」的事实抹掉（closed_by 同例）。
ALTER TABLE post_issues
  ADD COLUMN archived_at    timestamptz NULL,
  ADD COLUMN archived_by    bigint      NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN archive_reason text        NOT NULL DEFAULT '';

-- 未归档的全局聚合列表（GET /issues 的默认视图）：与 0005 的 idx_post_issues_global 同形 + 归档谓词。
-- 部分索引在这里是**对的**：谓词只引用本表的一列，引用完整性查找用不到这条索引
--（archived_by 是 ON DELETE SET NULL 外键，它的查找走下面那条普通索引）。
CREATE INDEX idx_post_issues_global_unarchived
  ON post_issues (status, updated_at DESC, id DESC) WHERE archived_at IS NULL;
-- archived_by 是外键：PG 不自动建索引，而 SET NULL 的级联查找需要它。
CREATE INDEX idx_post_issues_archived_by ON post_issues (archived_by);

-- ============================================================
-- ③ review_events：判定对象 = 主题 或 Issue
-- ============================================================
-- topic_id 由 NOT NULL 改为可空：Issue 的判定行**仍然带着它所属主题**
--（历史屏按主题找得到它，见 sqlSelectIssue 的注释），所以放宽的只是「必须有值」这一条。
-- 值域没变（0049/0060 的 ck_review_events_trigger 原样保留）。
ALTER TABLE review_events ALTER COLUMN topic_id DROP NOT NULL;
ALTER TABLE review_events ADD COLUMN issue_id bigint NULL REFERENCES post_issues(id) ON DELETE CASCADE;
-- 「恰好一个非空」：两个都空的行没有判定对象，是坏数据；两个都非空则说不清判的是谁。
ALTER TABLE review_events ADD CONSTRAINT ck_review_events_subject
  CHECK ((topic_id IS NULL) <> (issue_id IS NULL));
-- 外键索引（PG 不自动建；CASCADE 的级联删除要扫它）。
CREATE INDEX idx_review_events_issue ON review_events (issue_id, created_at DESC, id DESC);
