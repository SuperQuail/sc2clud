-- 0005_forum_issue down：先删引用方（issue_comments 引用 post_issues）。
DROP TABLE issue_comments;
DROP TABLE post_issues;
