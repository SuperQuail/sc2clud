import { cn } from '@/lib/utils';

// 权限徽标（独立控件）。**中性配色**：不按角色给颜色——颜色只留给头衔。
// 角色之间的差别由**名字**（roles.name）表达，所以权限树增减都不需要改这里。
// 一个用户可以同时有多个角色（user_roles 是关系表），使用方渲染多个即可。
export type UserRole = { key: string; name: string };

export function RoleBadge({ role, className }: { role: UserRole; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[4px] bg-muted px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      {role.name}
    </span>
  );
}
