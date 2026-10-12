import { cn } from '@/lib/utils';

// 权限徽标（独立控件）。**一个用户只有一个基线角色**（users.role_id）。
// 差异化的三套设计（与头衔配对评估，见 DevRoom 07）：
//   1 直角小标签   方角、中性底，像「分类」；与圆润的头衔形成形状对立
//   2 纯文字竖线   无边框，左侧一条竖线；最轻，不抢标题
//   3 实心深底     深底浅字的小块；最重，适合要强调身份的场合
export type RoleDesign = 1 | 2 | 3;
export type UserRole = { key: string; name: string; color?: string | null };

export function RoleBadge({
  role,
  design = 1,
  className,
}: {
  role: UserRole;
  design?: RoleDesign;
  className?: string;
}) {
  const c = role.color ?? null;
  const tint = c ? 'color-mix(in srgb, ' + c + ' 14%, transparent)' : undefined;

  if (design === 2) {
    return (
      <span className={cn('inline-flex shrink-0 items-center border-l-2 pl-1.5 text-[11px] font-medium whitespace-nowrap', !c && 'text-muted-foreground', className)}
        style={c ? { color: c, borderColor: c } : undefined}>
        {role.name}
      </span>
    );
  }

  if (design === 3) {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center rounded-[3px] px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap', !c && 'bg-foreground text-background', className)}
        style={c ? { backgroundColor: c, color: '#fff' } : undefined}
      >
        {role.name}
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded-[2px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', !c && 'bg-muted text-muted-foreground', className)}
      style={c ? { color: c, backgroundColor: tint } : undefined}
    >
      {role.name}
    </span>
  );
}
