-- 回滚是尽力而为：若已写入超过 16 字节的值，收窄会失败——按迁移 down 的语义让它报错。
ALTER TABLE topic_sources ALTER COLUMN size_text TYPE varchar(16);
ALTER TABLE topic_sources
  ADD CONSTRAINT ck_topic_sources_size CHECK (size_text = '' OR size_text ~ '^[0-9]+([.][0-9]+)? ?(B|KB|MB|GB|TB)$');
