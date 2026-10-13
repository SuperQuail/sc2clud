import type { BoardAcl } from '../mock';

// D6 判定的展示模型：判定顺序与「结论」都是纯函数/常量，所以单独放一个**数据文件**——
// 组件文件里混着常量导出会触发 react-refresh/only-export-components 告警。
export const D6_STEPS = [
  'actor.IsSuper → 放行',
  '有 Sanction 命中（20.2 第 21 条）→ 拒绝',
  'boards.acl_enabled = false → 放行（回到「登录即可发言」）',
  '任一角色命中 deny_post / deny_reply → 拒绝',
  '任一角色命中 can_post / can_reply → 放行',
  '都没命中 → 拒绝（该分区是白名单制）',
];

export type AclField = 'post' | 'reply';
export type Conclusion = { step: number; tone: 'ok' | 'danger' | 'warn'; text: string };

// 结论必须**带上 acl_enabled 这个前提**：上一版不看它，开关关掉时每行还写着「第 4 步先拒绝」，
// 与面板顶部的横幅自相矛盾。
export function aclConclusion(a: BoardAcl, field: AclField, aclEnabled: boolean, roleKey: string): Conclusion {
  // 超管在 D6 第 1 步就短路了：这一行的勾选永远不生效，所以结论不能写「第 6 步拒绝」
  if (roleKey === 'superadmin') return { step: 1, tone: 'ok', text: '第 1 步放行（超管短路）' };
  if (!aclEnabled) return { step: 3, tone: 'warn', text: '第 3 步放行（ACL 未启用）' };
  if (a[field === 'post' ? 'deny_post' : 'deny_reply']) return { step: 4, tone: 'danger', text: '第 4 步拒绝' };
  if (a[field === 'post' ? 'can_post' : 'can_reply']) return { step: 5, tone: 'ok', text: '第 5 步放行' };
  return { step: 6, tone: 'warn', text: '第 6 步拒绝' };
}

export const ACL_CELL = 'grid grid-cols-[minmax(104px,1.1fr)_repeat(4,56px)_minmax(132px,1.1fr)] items-center gap-x-1';
