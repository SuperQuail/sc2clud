-- 图片（blob）可见性：默认公开；将来出现保密图片时置 1，仅所有者与管理员可读。
ALTER TABLE blobs ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blobs ADD COLUMN owner_id INTEGER REFERENCES users(id);
