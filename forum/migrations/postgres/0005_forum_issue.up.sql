-- 0005_forum_issue：资源帖的「问题与建议」与它的评论
--
-- 依赖：post_issues.topic_id → topics、author_id/assignee_id/closed_by → users（0002/0004）；
--       issue_comments.issue_id → post_issues、parent_id → issue_comments（自引用，一级楼中楼）。
--
-- 与数据库设计 §4.11 的差异（以 d3-forum.md §2 的最终版为准）：
--   * post_issues 多了 number（帖内编号 #12）、assignee_id（?assignee=me 的落点）、
--     body_text（搜索输入）、tags、client_token、updated_at；
--   * status 的值域是 ('keep_open','closed')，不是 ('open','closed') —— API 的 ?status=open|closed
--     在 service 层映射（D3 §7.8）；
--   * 刻意**不建** open_count 计数列：详情页一条 count(*) WHERE (topic_id,status) 就够
--     （拍板 §6 最后一行）。

-- ============================================================
-- post_issues
-- ============================================================
CREATE TABLE post_issues (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     uuid         NOT NULL UNIQUE,
  topic_id      bigint       NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author_id     bigint       NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  assignee_id   bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  number        int          NOT NULL,
  kind          text         NOT NULL,
  title         varchar(120) NOT NULL,
  body_md       text         NOT NULL,
  body_html     text         NOT NULL,
  body_text     text         NOT NULL DEFAULT '',
  tags          text[]       NOT NULL DEFAULT '{}',
  status        text         NOT NULL DEFAULT 'keep_open',
  closed_by     bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  closed_at     timestamptz  NULL,
  client_token  varchar(64)  NOT NULL DEFAULT '',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_post_issues_kind   CHECK (kind IN ('bug','feature','difficulty','other')),
  CONSTRAINT ck_post_issues_status CHECK (status IN ('keep_open','closed')),
  CONSTRAINT ck_post_issues_number CHECK (number >= 1),
  CONSTRAINT ck_post_issues_tags   CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 5),
  CONSTRAINT ck_post_issues_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_post_issues_topic_number ON post_issues (topic_id, number);
-- 全站 Issue 聚合（等值 status 在前、排序键在后，与游标同序）
CREATE INDEX idx_post_issues_global     ON post_issues (status, updated_at DESC, id DESC);
-- 帖内列表 + open 计数：前缀 (topic_id, status) 就是拍板 §6 指定的形状
CREATE INDEX idx_post_issues_topic_status ON post_issues (topic_id, status, updated_at DESC, id DESC);
CREATE INDEX idx_post_issues_tags       ON post_issues USING gin (tags);
-- 外键索引（PG 不自动建）
CREATE INDEX idx_post_issues_author     ON post_issues (author_id, id DESC);
-- assignee_id 是 ON DELETE SET NULL 外键：**不能是部分索引**，引用完整性查找用不了带谓词的索引
-- （数据库文档 §12 第 1 条 ②）。「指派给我」的查询自己带上 assignee_id IS NOT NULL，谓词放查询里。
CREATE INDEX idx_post_issues_assignee   ON post_issues (assignee_id);
CREATE INDEX idx_post_issues_closed_by  ON post_issues (closed_by);
CREATE UNIQUE INDEX uq_post_issues_author_client_token ON post_issues (author_id, client_token)
  WHERE client_token <> '';

-- ============================================================
-- issue_comments（与 posts 同构，只允许一级楼中楼；不加 number）
-- ============================================================
CREATE TABLE issue_comments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     uuid        NOT NULL UNIQUE,
  issue_id      bigint      NOT NULL REFERENCES post_issues(id) ON DELETE CASCADE,
  author_id     bigint      NOT NULL REFERENCES users(id)       ON DELETE RESTRICT,
  parent_id     bigint      NULL REFERENCES issue_comments(id)  ON DELETE SET NULL,
  body_md       text        NOT NULL,
  body_html     text        NOT NULL,
  visibility    text        NOT NULL DEFAULT 'normal',
  like_count    int         NOT NULL DEFAULT 0,
  dislike_count int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_issue_comments_visibility CHECK (visibility IN ('normal','hidden','deleted')),
  CONSTRAINT ck_issue_comments_counts     CHECK (like_count >= 0 AND dislike_count >= 0)
);

CREATE INDEX idx_issue_comments_issue  ON issue_comments (issue_id, id);
CREATE INDEX idx_issue_comments_author ON issue_comments (author_id);
-- FK 索引不能是部分索引（引用完整性查找用不了谓词），这里是普通索引
CREATE INDEX idx_issue_comments_parent ON issue_comments (parent_id);
