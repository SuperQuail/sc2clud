-- 0023_moderator_to_creator：把自定义角色 `moderator` 并进内置角色 `creator`（拍板 08 · J1）。
--
-- 「自动迁移到 creator，只是命名变化」—— moderator 与 creator 表达的是同一件事
-- （「经认证的版主/创作者」），保留两个 key 等于同一件事有两份真源。
-- 0017_seed_authz 从来只种 user/creator/admin/superadmin；这里收的是**自定义角色**那一路
-- （后台可以建 key=moderator 的角色，W5 的假数据就这么造的）。
--
-- 两条分支，不允许半途而废：
--   ① 没有 creator  → 直接把 moderator 就地改名成 creator（连带 name/badge_color，id 不变，权限矩阵跟着走）；
--   ② 已有 creator  → moderator 的用户改挂 creator，然后删掉 moderator（矩阵行随 ON DELETE CASCADE 消失）。
-- creator 是 is_system 角色，绝不覆盖它已有的列（这就是 0017 那条「重跑不覆盖」的纪律）。

-- ① 就地改名（只在 creator 不存在时）
UPDATE roles
   SET key         = 'creator',
       name        = '认证创作者',
       description = '经认证的资源作者',
       badge_color = COALESCE(badge_color, '#2563eb'),
       is_system   = true,
       updated_at  = now()
 WHERE key = 'moderator'
   AND NOT EXISTS (SELECT 1 FROM roles WHERE key = 'creator');

-- ② 并进已存在的 creator（改名那条跑过之后，moderator 已经不存在，这个 UPDATE 是空操作）
UPDATE users
   SET role_id = (SELECT id FROM roles WHERE key = 'creator')
 WHERE role_id IN (SELECT id FROM roles WHERE key = 'moderator')
   AND EXISTS (SELECT 1 FROM roles WHERE key = 'creator');

-- users.role_id 是 ON DELETE RESTRICT：上一步之后 moderator 下已经没有用户，这里才删得掉。
-- 把 moderator 的权限矩阵并进 creator 再删，免得丢掉后台给它勾的点。
INSERT INTO role_permissions (role_id, permission_id)
SELECT c.id, rp.permission_id
  FROM roles m
  JOIN roles c ON c.key = 'creator'
  JOIN role_permissions rp ON rp.role_id = m.id
 WHERE m.key = 'moderator'
ON CONFLICT (role_id, permission_id) DO NOTHING;
DELETE FROM roles WHERE key = 'moderator';
