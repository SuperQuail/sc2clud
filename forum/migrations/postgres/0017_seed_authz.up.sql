-- 0017_seed_authz.up.sql —— 数据迁移：4 个内置角色 + 24 个权限点 + 角色×权限矩阵
-- 依据：拍板 §1.2（权限点全集，24 个，逐字）、§1.3（4 个内置角色，无 moderator）、§1.4（一人一个基线角色）；
--       d1-platform §8.1（0017_seed_authz）；d2-auth §5.4/§5.5/§5.6 与 §8.6。
--
-- 幂等：全部 INSERT 走 ON CONFLICT DO NOTHING（矩阵那条用 WHERE NOT EXISTS，见下）。
-- **不覆盖后台调整**：重跑不会把管理员改过的勾选抹回原样（d2 §8.6 末段）。
-- 权限点只能由这条迁移写入，后台禁止新增权限点。

-- ============================================================
-- 1) 四个内置角色（parent_id 全 NULL：各自独立，不成链 —— d2 §5.4/§8.6）
-- ============================================================
INSERT INTO roles (key, name, description, parent_id, depth, badge_color, is_system, is_super, priority)
VALUES
  ('user',       '普通用户',   '注册即得',                   NULL, 0, NULL,      true, false, 0),
  ('creator',    '认证创作者', '经认证的资源作者',           NULL, 1, '#2563eb', true, false, 1),
  ('admin',      '管理员',     '内容与用户管理',             NULL, 2, '#d97706', true, false, 2),
  ('superadmin', '超级管理员', '不可被降权，只能由 CLI 授予', NULL, 3, '#dc2626', true, true,  3)
ON CONFLICT (key) DO NOTHING;
-- 注意：不给已存在的角色 UPDATE 名称/颜色/深度 —— 「重跑不覆盖」是这条迁移的纪律。
-- superadmin 的 is_super = true，由 0003 的 uq_roles_super 保证全库唯一。

-- ============================================================
-- 2) 24 个权限点（与拍板 §1.2 的表逐字相同，顺序也照那张表）
--    grp ∈ {topic, board, user, title, site}（d2 §5.5）
-- ============================================================
INSERT INTO permissions (key, grp, name, description) VALUES
  ('topic.create',      'topic', '发主题与回复',     '发主题、发回复、发 issue 与 issue 评论'),
  ('topic.edit.own',    'topic', '编辑自己的内容',   '改自己的主题 / 回复 / issue'),
  ('topic.delete.own',  'topic', '删除自己的内容',   '删自己的主题 / 回复'),
  ('topic.delete.any',  'topic', '删除任何人的内容', '删任何人的（service 配合归属判定）'),
  ('topic.lock',        'topic', '锁定主题',         '锁定 / 解锁'),
  ('topic.pin',         'topic', '置顶与精华',       '置顶 / 精华（两个端点共用这一个权限点，v2 §21.2）'),
  ('topic.move',        'topic', '移动主题',         '把主题移到别的分区'),
  ('resource.publish',  'topic', '发资源帖',         '发 kind=resource 的主题（在普通发帖之上多这一条）'),
  ('board.manage',      'board', '分区管理',         '分区增删改、排序、封面、BoardACL'),
  ('board.moderate',    'board', '分区版主',         '作用域权限：只在 board_moderators 命中的分区内生效'),
  ('post.review',       'topic', '帖子审核',         '审核队列：放行 / 拒绝 / 请求修改'),
  ('report.handle',     'user',  '处理举报',         '举报队列'),
  ('reward.verify',     'user',  '赞赏核验',         '人工核验打赏申报'),
  ('title.grant',       'title', '授予头衔',         '给用户发 / 收头衔'),
  ('title.manage',      'title', '头衔目录维护',     '新建 / 归档头衔'),
  ('role.edit',         'user',  '编辑角色权限',     '改角色 × 权限矩阵'),
  ('role.assign',       'user',  '分配角色',         '改 users.role_id（与 role.edit 必须分开）'),
  ('permission.grant',  'user',  '点对点授权',       '追加 / 回收某人的权限点（user_permissions）'),
  ('user.ban',          'user',  '封号与解封',       '封号 / 解封 / 禁言'),
  ('user.mute',         'user',  '分区限期禁言',     'Sanction 表'),
  ('mail.manage',       'site',  '发信账号维护',     '后台邮件账号'),
  ('site.setting',      'site',  '站点设置',         '键值、公告、横幅、自检面板'),
  ('audit.view',        'site',  '查看审计日志',     '—'),
  ('audit.export',      'site',  '导出审计日志',     '单列：能一次导走全站操作痕迹')
ON CONFLICT (key) DO NOTHING;
-- 再次提醒：DO NOTHING 而不是 DO UPDATE —— 后台可以改 name / description（那是给人看的标签），
-- 迁移不该把人的调整抹掉。权限点 key 集合的一致性由启动自检比对（d1 §10 第 3 条）。

-- ============================================================
-- 3) 角色 × 权限矩阵（role_permissions）
--    合计：user 3 个、creator 8 个、admin 17 个、superadmin 24 个
-- ============================================================

-- 普通用户 3 个
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.key IN (
    'topic.create','topic.edit.own','topic.delete.own')
 WHERE r.key = 'user'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- 认证创作者 8 个：user 的 3 个 + 锁定 / 移动 / 置顶精华 / 发资源帖
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.key IN (
    'topic.create','topic.edit.own','topic.delete.own',
    'topic.lock','topic.move','topic.pin','resource.publish')
 WHERE r.key = 'creator'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- 管理员 17 个：creator 的 7 个（不含 resource.publish）+ 管理类 10 个
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.key IN (
    'topic.create','topic.edit.own','topic.delete.own',
    'topic.lock','topic.move','topic.pin',
    'topic.delete.any','board.manage','board.moderate','post.review',
    'report.handle','reward.verify','title.grant','title.manage','user.ban','user.mute')
 WHERE r.key = 'admin'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- 超级管理员 24 个（全部）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
 CROSS JOIN permissions p
 WHERE r.key = 'superadmin'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);
