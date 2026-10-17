-- 0028_topic_revisions：审核的「打回修改」独立状态 + 最后过审版本（拍板 08 · L6）。
--
-- 用户原话：「完善,实现打回修改功能,单独一个分类,不复用打回,打回修改期间只有作者可见和可编辑,
-- 如果是原始版本过审的显示最后一个过审版本」。
--
-- 三件事在这一条迁移里：
--   1. **第四态** revision_requested：不复用 rejected。原设计（后端接口对账 §3 的取舍 1）
--      把它砍掉的理由是「在作者那一侧与 rejected 完全同形」—— 现在产品明确要区分
--      「改改就能过」与「直接拒绝」，那就是可感知的差别，第四态成立。
--   2. **只有作者可见**：可见性谓词本来就是 `review_state = approved OR author_id = $viewer`，
--      第四态天然落在「只有作者」那一侧 —— 不需要改任何列表 SQL。
--   3. **最后过审版本**（topic_revisions）：打回期间作者改的是**新内容**，而读者/审核员
--      应看到**最后一份过审的内容**。批准那一刻把 1 楼正文快照进来，一帖一份（UPSERT）。

-- ① 值域加第四态
ALTER TABLE topics DROP CONSTRAINT IF EXISTS ck_topics_review_state;
ALTER TABLE topics ADD CONSTRAINT ck_topics_review_state
  CHECK (review_state IN ('pending', 'approved', 'rejected', 'revision_requested'));

-- ①b review_events.verdict 也要认这一档（0020 的值域是 approve|reject|review）。
-- 判定事件是「谁判的、判过几次」的真源，第四态必须留下自己那一条 ——
-- 少了这个，打回动作会以 23514（CHECK 违约）整条回滚，看起来像「打回功能坏了」。
ALTER TABLE review_events DROP CONSTRAINT IF EXISTS ck_review_events_verdict;
ALTER TABLE review_events ADD CONSTRAINT ck_review_events_verdict
  CHECK (verdict IN ('approve', 'reject', 'review', 'revision_requested'));

-- ② 队列索引的谓词是 review_state <> 'approved'，第四态自动进队列；
--    这里只为「查某一档」补一条，避免退化成全表扫（索引很小，主题量级万级）。
CREATE INDEX idx_topics_review_state ON topics (review_state, created_at DESC, id DESC);

-- ③ 最后过审版本。**一帖一份**（uq_topic_revisions_topic）：
--    「最后过审版本」只有一个，留一串历史是另一个需求（审定稿归档），现在没人要。
--    内容三列与 posts 逐字同名同类型，读的时候可以整段替换而不做转换。
CREATE TABLE topic_revisions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic_id     bigint      NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  post_id      bigint      NOT NULL REFERENCES posts(id)  ON DELETE CASCADE,
  content_md   text        NOT NULL,
  content_html text        NOT NULL,
  -- 哪一次判定让它成为「过审版本」：审核事件是事实来源，这里只留一个可追溯的指针。
  approved_by  bigint      NULL REFERENCES users(id) ON DELETE SET NULL,
  approved_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_topic_revisions_topic ON topic_revisions (topic_id);
-- 外键列的非部分索引（platform/db 的启动自检要求，RI 查找用不了部分索引）。
CREATE INDEX idx_topic_revisions_post      ON topic_revisions (post_id);
CREATE INDEX idx_topic_revisions_approved  ON topic_revisions (approved_by);
