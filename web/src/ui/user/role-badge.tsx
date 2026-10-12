import { cn } from '@/lib/utils';
import { roleColor, type RoleLike } from './role-color';

// 权限徽标（独立控件）。**不假设有哪些角色**：颜色由 key 派生，或由数据给定。
// 一个用户可以同时有多个角色（user_roles 是关系表），所以使用方可能要渲染多个。
export type UserRole = RoleLike;

export function RoleBadge({ role, className }: { role: UserRole; className?: string }) {
  const c = roleColor(role.key, role.color);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', className)}
      style={{ color: c, backgroundColor: 'color-mix(in srgb, ' + c + ' 14%, transparent)' }}
    >
      {role.name}
    </span>
  );
}
