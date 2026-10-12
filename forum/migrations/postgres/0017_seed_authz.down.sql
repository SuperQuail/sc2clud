-- 0017_seed_authz.down.sql —— 回滚这条数据迁移插入的行
-- 顺序说明：先删矩阵，再删权限点与角色。CASCADE 会兜住遗漏，但先删矩阵是更直白的顺序。
--
-- 注意：只删这四个内置角色与 permissions 表里的全部行（权限点只能由 0017 写入，拍板禁止后台新增）。

DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles
                    WHERE key IN ('user','creator','admin','superadmin'));

DELETE FROM roles
 WHERE key IN ('user','creator','admin','superadmin')
   AND parent_id IS NULL;          -- 四个内置角色 parent_id 全 NULL（与 0017 的插入条件一致）

DELETE FROM permissions;
