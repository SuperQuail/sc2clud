// 前端权限 mock —— **前端权限只决定「显不显示」，真正的判定在后端**（前端方案 §5.4 / 后端方案 §9.8）。
//
// 为什么要有这份本地 mock：`@/lib/perms` 目前并不存在（Lead 已 grep 确认全仓库无此文件），
// 所以这里按将来 `useCan(perm)` 的语义自己做一份最小实现：
//   useCan(perm)   ↔  GET /api/v1/me 返回的 `perms: string[]`
//   useIsSuper()   ↔  /me 返回的 `is_super`（超管在后端 authz.Require 与中间件里都短路）
//   useInBoard(id) ↔  authz.CanInBoard：全局权限 **或** board_moderators 命中（D6/9.8）
//
// 用法约定：这两个函数长得像 hook（语义就是 hook），所以**只在组件顶层调用一次**，
// 把布尔值传下去/用在回调里。不要在 map 回调或条件分支里调用（react-hooks 规则会红）。
//
// 反例（本项目禁止）：因为按钮没渲染，就认为后端可以不查权限。隐藏按钮只是为了界面干净。

// 值班管理员（role=admin 基线）**加上点对点追加**（RBAC权限树设计.md §1.2：追加带 reason 与 expires_at）。
export const CURRENT_ADMIN = {
  handle: 'tangtian',
  nickname: '唐恬',
  role_key: 'admin',
  is_super: false,
  // 界面右上角「权限明细」要展示的东西：基线 + 追加（含到期时间与理由）
  extra_permissions: [
    { key: 'role.edit', reason: '权限矩阵整理（限期任务）', expires_at: '2026-11-30T15:59:59Z' },
    { key: 'board.manage', reason: '分区与 ACL 维护', expires_at: null },
    { key: 'user.ban', reason: '值班管理员', expires_at: '2027-01-31T15:59:59Z' },
    { key: 'title.grant', reason: '发头衔（目录维护权在超管）', expires_at: null },
    { key: 'mail.manage', reason: '发信账号值班维护', expires_at: null },
    { key: 'site.setting', reason: '站点文案维护', expires_at: null },
    { key: 'audit.view', reason: '季度审计', expires_at: '2026-12-31T15:59:59Z' },
  ],
} as const;

// admin 基线（RBAC权限树设计.md §3 的表：admin 那一列）+ 上面的追加。
// **刻意不持有**：role.assign（分配角色）、system.settings（超管级系统配置）、title.manage（头衔目录维护）——
// 这三条正是本页每个屏「权限不足就不渲染」示例的来源。
export const MOCK_PERMS: readonly string[] = [
  // 内容（admin 基线）
  'post.create', 'post.update_own', 'post.delete_own', 'post.pin', 'post.delete_any', 'post.lock', 'post.move', 'post.review',
  // 用户
  'user.warn', 'user.mute',
  // 分区（admin 基线含 board.moderate：只在 board_moderators 命中的分区内有效）
  'board.moderate',
  // 运营
  'report.handle', 'reward.verify',
  // 追加来的
  ...CURRENT_ADMIN.extra_permissions.map((p) => p.key),
];

// 当前管理员的 board_moderators（作用域）：分区页/审核页用它演示「同一个权限点，换个分区就不成立」。
export const MOCK_MODERATED_BOARDS: readonly string[] = ['campaign', 'resources'];

export function useCan(perm: string): boolean {
  return MOCK_PERMS.includes(perm);
}

export function useIsSuper(): boolean {
  return CURRENT_ADMIN.is_super;
}

/** 作用域判定（authz.CanInBoard）：带分区语义的权限必须在该分区的 board_moderators 里命中。
 *  为什么不做成「全局命中就算」：board.moderate 这一行在 RBAC权限树设计.md §3 里本来就写着
 *  「在 board_moderators 命中的分区内」——全局拿到这个权限点，不等于每个分区都能用（D6 的作用域）。 */
export function canInBoard(boardSlug: string, perm: string): boolean {
  return MOCK_PERMS.includes(perm) && MOCK_MODERATED_BOARDS.includes(boardSlug);
}

export const NOT_HELD = ['role.assign', 'system.settings', 'title.manage'] as const;
