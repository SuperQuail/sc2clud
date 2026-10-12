import type { AdminRole, Permission } from './core';

// 角色树与权限点目录 —— mock 里**只读**：权限点的唯一真源是后端代码常量（§9.8），后台不许新增权限点。
// 角色链照 RBAC权限树设计.md §3 的四个内置角色；moderator 是 9.8 列为内置、RBAC 文档未列的那个（见回报的存疑项）。
export const ROLES: AdminRole[] = [
  {
    id: 'r_user', key: 'user', name: '普通用户', parent_id: null, depth: 0, is_system: true, priority: 10, member_count: 1284,
    description: '注册即得的基线角色', color: null,
  },
  {
    id: 'r_creator', key: 'creator', name: '认证创作者', parent_id: 'r_user', depth: 1, is_system: true, priority: 20, member_count: 63,
    description: '认证过战役/地图作者的账号', color: '#2563eb',
  },
  {
    id: 'r_moderator', key: 'moderator', name: '分区版主', parent_id: 'r_creator', depth: 2, is_system: false, priority: 30, member_count: 7,
    description: '只在 board_moderators 命中的分区内生效（自定义角色，可删）', color: '#0891b2',
  },
  {
    id: 'r_admin', key: 'admin', name: '管理员', parent_id: 'r_creator', depth: 2, is_system: true, priority: 40, member_count: 4,
    description: '用户、内容、分区与运营队列', color: '#7c3aed',
  },
  {
    id: 'r_superadmin', key: 'superadmin', name: '超级管理员', parent_id: 'r_admin', depth: 3, is_system: true, priority: 50, member_count: 2,
    description: '最高权限；只能由 forum create-admin 授予，系统里至少保留一个', color: '#f97316',
  },
];

export const PERM_GROUPS = ['内容', '用户', '授权', '分区', '运营', '系统'] as const;

export const PERMISSIONS: Permission[] = [
  { key: 'post.create', grp: '内容', description: '发主题 / 发回复' },
  { key: 'post.update_own', grp: '内容', description: '编辑自己的内容' },
  { key: 'post.delete_own', grp: '内容', description: '删除自己的内容' },
  { key: 'post.delete_any', grp: '内容', description: '删除任何人的内容' },
  { key: 'post.lock', grp: '内容', description: '锁定 / 解锁主题' },
  { key: 'post.pin', grp: '内容', description: '置顶 / 精华' },
  { key: 'post.move', grp: '内容', description: '移动主题到其它分区' },
  { key: 'post.review', grp: '内容', description: '人工审核队列：通过 / 拒绝 / 请求修改' },
  { key: 'resource.publish', grp: '内容', description: '发资源帖（kind=resource）' },
  { key: 'user.warn', grp: '用户', description: '警告用户' },
  { key: 'user.mute', grp: '用户', description: '禁言（全局 / 指定分区，带到期时间）' },
  { key: 'user.ban', grp: '用户', description: '封号 / 解封（users.status）' },
  { key: 'role.edit', grp: '授权', description: '改角色的权限矩阵' },
  { key: 'role.assign', grp: '授权', description: '给用户分配角色（与 role.edit 必须分开）' },
  { key: 'title.grant', grp: '授权', description: '给用户发 / 收头衔' },
  { key: 'board.manage', grp: '分区', description: '分区增删改、排序、封面、ACL' },
  { key: 'board.moderate', grp: '分区', description: '分区内删帖 / 置顶（只在命中的分区）' },
  { key: 'report.handle', grp: '运营', description: '处理内容举报' },
  { key: 'reward.verify', grp: '运营', description: '人工核验打赏记录' },
  { key: 'title.manage', grp: '运营', description: '头衔目录维护（归档而非删除）' },
  { key: 'mail.manage', grp: '系统', description: '发信账号与测试发信' },
  { key: 'site.setting', grp: '系统', description: '站点设置、文案、公告与横幅' },
  { key: 'audit.view', grp: '系统', description: '查审计日志（含提权类操作）' },
  { key: 'system.settings', grp: '系统', description: '系统级配置：主域名、备份、debug 开关（超管）' },
];

/** role_permissions：**已展开的并集**（写穿到子角色，§9.8；子角色不用单独配父角色的点）。 */
export const ROLE_PERMS: Record<string, string[]> = {
  r_user: ['post.create', 'post.update_own', 'post.delete_own'],
  r_creator: ['post.create', 'post.update_own', 'post.delete_own', 'post.pin', 'resource.publish'],
  r_moderator: [
    'post.create', 'post.update_own', 'post.delete_own', 'post.pin', 'resource.publish',
    'post.delete_any', 'post.lock', 'board.moderate',
  ],
  r_admin: [
    'post.create', 'post.update_own', 'post.delete_own', 'post.pin', 'resource.publish',
    'post.delete_any', 'post.lock', 'post.move', 'post.review',
    'user.warn', 'user.mute', 'report.handle', 'reward.verify',
  ],
  r_superadmin: PERMISSIONS.map((p) => p.key),
};

export const PERM_GROUP_OF: Record<string, string> = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.grp]));
