import { cn } from '@/lib/utils';

// 权限徽标（独立控件）。**颜色可选、由数据给**（角色记录里的配色字段），不传就是中性。
// 控件不认识任何具体角色——权限树增减不影响这里。
// 一个用户可以同时有多个角色（user_roles 是关系表），使用方渲染多个即可。
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
