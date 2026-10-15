import type { AdminACLItem } from '@/lib/api/admin';

// 判定结论的**展示模型**：纯函数/常量单独放一个数据文件 —— 组件文件里混着常量导出会触发
// react-refresh/only-export-components 告警。
// 结论是**给管理员读的**（D39）：说的是「这个角色在这个分区会怎样」，不是给开发者用的步骤编号。
// 顺序的事实写在 canSpeak（forum/acl.go）：禁言 → 分区开关 → 名单（禁 → 允）→ 等级门槛。
export type AclField = 'post' | 'reply';
export type Conclusion = { tone: 'ok' | 'danger' | 'warn'; text: string };

export function aclConclusion(a: AdminACLItem, field: AclField, aclEnabled: boolean, roleKey: string): Conclusion {
  if (roleKey === 'superadmin') {
    return { tone: 'ok', text: '全域继承：不受这里的名单控制' };
  }
  if (!aclEnabled) return { tone: 'warn', text: '开关未启用：登录即可' };
  if (a[field === 'post' ? 'deny_post' : 'deny_reply']) return { tone: 'danger', text: '被「禁止」挡下' };
  if (a[field === 'post' ? 'can_post' : 'can_reply']) {
    return { tone: 'ok', text: '放行（仍要过等级门槛）' };
  }
  return { tone: 'warn', text: '名单没放行 → 拒绝' };
}

export const ACL_CELL = 'grid grid-cols-[minmax(104px,1.1fr)_repeat(4,56px)_minmax(132px,1.1fr)] items-center gap-x-1';