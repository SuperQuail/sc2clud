-- 0004_forum down：逆序删。先撤本文件给 board_moderators 补的外键，再删依赖方。
ALTER TABLE board_moderators DROP CONSTRAINT fk_board_moderators_board;
DROP TABLE topic_sources;
DROP TABLE topic_images;
DROP TABLE posts;
DROP TABLE topics;
DROP TABLE board_acls;
DROP TABLE boards;
