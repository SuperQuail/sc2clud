-- 0040_follows 的回滚：整张表删掉（本迁移没有改动别的表，所以 down 就这么短）。
DROP TABLE IF EXISTS follows;
