import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { cn } from '@/lib/utils';

// 权限徽标（基线角色，一人一个）。**全部走「带颜色的半透明背景」**，三套做法：
//   1 Ring UI Tag + tagType 预设（现成控件，预设色自带半透明底）
//   2 Tailwind alpha：bg-primary/12（我们的令牌在 @theme 里，透明度修饰符直接生效）
//   3 Tailwind alpha + 左侧色条（border-l-4 同色），用于「比头衔更重」的场合
export type RoleDesign = 1 | 2 | 3;
export type UserRole = { key: string; name: string; color?: string | null; tagType?: TagType };

export function RoleBadge({ role, design = 1, className }: { role: UserRole; design?: RoleDesign; className?: string }) {
  if (design === 1) {
    // 用 Ring UI 现成的 Tag：预设 tagType，或用 backgroundColor 传半透明色
    return (
      <Tag
        tagType={role.tagType ?? TagType.MAIN}
        backgroundColor={role.color ? 'color-mix(in srgb, ' + role.color + ' 14%, transparent)' : undefined}
        textColor={role.color ?? undefined}
        className={cn('shrink-0 text-[11px]', className)}
      >
        {role.name}
      </Tag>
    );
  }

  const alpha = role.color ? undefined : 'bg-primary/10 text-primary';
  const style = role.color
    ? { color: role.color, backgroundColor: 'color-mix(in srgb, ' + role.color + ' 12%, transparent)' }
    : undefined;

  if (design === 3) {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center rounded-[3px] border-l-4 py-0.5 pl-1.5 pr-1.5 text-[11px] font-medium whitespace-nowrap', alpha, className)}
        style={{ ...style, borderColor: role.color ?? 'var(--primary)' }}
      >
        {role.name}
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', alpha, className)}
      style={style}
    >
      {role.name}
    </span>
  );
}
