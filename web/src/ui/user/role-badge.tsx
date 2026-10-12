import { cn } from '@/lib/utils';

// 权限徽标。**独立控件**：场景不同只换排布（放名字前/后/单独一行），不要重新设计。
// 我们的权限是角色（管理员 / 版主 / 会员），不是等级——没有 level 系统。
const TONE: Record<string, string> = {
  admin: 'bg-destructive/12 text-destructive',
  moderator: 'bg-primary/12 text-primary',
  member: 'bg-muted text-muted-foreground',
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
