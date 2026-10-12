import { cn } from '@/lib/utils';

// 权限徽标。**独立控件**：场景不同只换排布（名字前/后/单独一行/表格列），不要为场景改它。
// 角色 key 取自数据库的四个内置 roles（见 数据库设计 §10.5 的角色映射）：
//   user / moderator / admin / superadmin
// 注意：一个用户**可以同时有多个角色**（user_roles 是关系表），所以使用方可能要渲染多个徽标。
const TONE: Record<string, string> = {
  superadmin: 'bg-foreground/10 text-foreground',
  admin: 'bg-destructive/12 text-destructive',
  moderator: 'bg-primary/12 text-primary',
  user: 'bg-muted text-muted-foreground',
};

export type UserRole = { key: string; name: string };

export function RoleBadge({ role, className }: { role: UserRole; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        TONE[role.key] ?? 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {role.name}
    </span>
  );
}
