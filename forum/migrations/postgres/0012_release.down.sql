-- 0012_release.down.sql —— 逆序回滚（release_assets 先，releases 后）
DROP TABLE release_assets;
DROP TABLE releases;
