import { cn } from '@/lib/utils';

// 权限徽标（独立控件）。**一个用户只有一个角色**——权限树是层级：
//   超级管理员 / 管理员 / 认证创作者 / 普通用户
// 颜色可选、由数据给（角色记录上的配色字段）；不配就是中性徽标。
// 控件不认识任何具体角色，权限树增减不影响这里。
export type UserRole = { key: string; name: string; color?: string | null };

export function RoleBadge({ role, className }: { role: UserRole; className?: string }) {
  const c = role.color ?? null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        c ? undefined : 'bg-muted text-muted-foreground',
        className,
      )}
      style={c ? { color: c, backgroundColor: 'color-mix(in srgb, ' + c + ' 14%, transparent)' } : undefined}
    >
      {role.name}
    </span>
  );
}
