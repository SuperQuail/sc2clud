-- 0052_admin_resource_publish：给内置角色 admin 补上 resource.publish。
--
-- 真源：完全重构/后端开工前拍板.md §1.3（内置角色，冻结 4 个）——
--   admin ＝ topic.* 全部 + board.manage/board.moderate/post.review/report.handle/
--            reward.verify/title.*/user.ban/user.mute
--   而 §1.2 的 topic.* 有**八个**权限点，其中就含 resource.publish（U1 也明文确认：
--   「资源帖权限在 creator/admin/superadmin 上」）。
--
-- 0017_seed_authz 给 admin 写了 16 个点，漏了 resource.publish（那条的注释自己写的是 17 个）。
-- 后果不是「少一个勾」：没有它，管理员发一篇 kind=resource 的帖子会被 403 拦下，
-- 而这是后台里最日常的动作之一（替创作者补发资源帖）。
--
-- 为什么是新迁移而不是改 0017：golang-migrate 只跑**没跑过**的版本（platform/db.Migrate），
-- 改 0017 对已经迁移过的实例（dev / 未来的 prod）没有任何作用 —— 那种「改了但没生效」
-- 比不改更糟。0017 保持原样（历史记录），由这一条收敛。
--
-- 幂等 + 不覆盖后台调整：只补这一个点，用 WHERE NOT EXISTS 而不是整表重写；
-- 后台把 admin 的其他点改过的，这里一个字都不动（0017 那条「重跑不覆盖」的纪律继续有效）。
-- 判据在 forum/internal/app/role_permissions_test.go：迁移后的 role_permissions 必须与
-- 拍板 §1.2/§1.3 的矩阵逐点相同。

-- 前置断言：权限点或角色不在表里时**必须红**。JOIN 不到就是 0 行，迁移会「成功」而什么都没补 ——
-- 那种静默失败正是这一条要修的病（0017 漏点也是静默的）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'resource.publish') THEN
    RAISE EXCEPTION '0052: permissions 表里没有 resource.publish —— 0017_seed_authz 没跑过？';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM roles WHERE key = 'admin') THEN
    RAISE EXCEPTION '0052: roles 表里没有 admin —— 0017_seed_authz 没跑过？';
  END IF;
END $$;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.key = 'resource.publish'
 WHERE r.key = 'admin'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);
