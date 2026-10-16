-- 图片可见性由「布尔 private」升级为三档：0 公开 / 1 登录可见 / 2 仅所有者与管理员
ALTER TABLE blobs ADD COLUMN visibility INTEGER NOT NULL DEFAULT 0;
-- 原有的保密图（收款码）按「登录可见」处理：捐赠者登录后要能扫码
UPDATE blobs SET visibility = 1 WHERE private = 1;
ALTER TABLE blobs DROP COLUMN private;
