-- issue 评论支持楼中楼与点赞（与帖子评论对齐：parent_id 一级到底，votes 单独一张表）
ALTER TABLE issue_comments ADD COLUMN parent_id INTEGER REFERENCES issue_comments(id);

CREATE TABLE IF NOT EXISTS issue_comment_votes (
  comment_id INTEGER NOT NULL REFERENCES issue_comments(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  value      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_comment_votes_comment ON issue_comment_votes(comment_id);
