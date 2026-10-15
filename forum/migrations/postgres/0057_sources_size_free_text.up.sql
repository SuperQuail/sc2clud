-- D70（用户 2026-10-15 21:0x 拍板）：size_text 就是普通展示文本，**不按格式检查**。
-- 我们不托管文件，大小写什么由发帖人自己写；之前 ck_topic_sources_size 的正则
-- （^[0-9]+([.][0-9]+)? ?(B|KB|MB|GB|TB)$）会直接把自由写法判死：
-- 用户在 prod 保存来源撞上它（SQLSTATE 23514 → 500 request_id da414cc6…）。
-- 顺带把列放宽到 varchar(64)：16 字节连「约 1.5 GB 未知」都装不下，会变成下一个 500。
-- ck_topic_sources_url 的 https?:// 保留——它是协议防线，跟这一条无关。
ALTER TABLE topic_sources DROP CONSTRAINT IF EXISTS ck_topic_sources_size;
ALTER TABLE topic_sources ALTER COLUMN size_text TYPE varchar(64);
