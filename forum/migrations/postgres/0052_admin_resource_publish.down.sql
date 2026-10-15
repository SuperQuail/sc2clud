-- 0052 的回滚：把 admin 的 resource.publish 收回去。
-- 只在它确实存在时删（否则重跑 down 会「成功」地什么也没做，看起来像回滚过了）。
DELETE FROM role_permissions rp
 USING roles r, permissions p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id
   AND r.key = 'admin' AND p.key = 'resource.publish';
