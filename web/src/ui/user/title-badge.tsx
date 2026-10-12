import { cn } from '@/lib/utils';

// 头衔控件。数据来自 titles 表：key / name / color / description；
// 用户只佩戴一个（users.equipped_title_id），所以这个控件一次只渲染一个头衔。
//
// 四个样式：plain 是「素」的原型（留着做对照），gradient / outline / glow 是三版候选。
// 颜色只从一个 color 派生：渐变用 color → 压暗 28%，光晕用同色，所以运营配一个色就够。
const SIZE = { sm: 'text-[11px]', md: 'text-xs', lg: 'text-sm' } as const;

export type UserTitle = { key?: string; name: string; color?: string | null; description?: string | null };
export type TitleVariant = 'plain' | 'gradient' | 'outline' | 'glow';

export function TitleBadge({
  title,
  variant = 'outline',
  size = 'md',
  className,
}: {
  title: UserTitle;
  variant?: TitleVariant;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const c = title.color ?? 'var(--primary)';
  const base = cn(
    'inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-semibold',
    SIZE[size],
    variant !== 'plain' && 'rounded-[5px] px-1.5 py-0.5',
    className,
  );

  if (variant === 'plain') {
    return (
      <span
        title={title.description ?? undefined}
        className={cn(base, 'font-medium')}
        style={{ color: c, backgroundColor: 'color-mix(in srgb, ' + c + ' 14%, transparent)' }}
      >
        {title.name}
      </span>
    );
  }

  if (variant === 'gradient') {
    return (
      <span
        title={title.description ?? undefined}
        className={cn(base, 'text-white shadow-sm')}
        style={{
          backgroundImage:
            'linear-gradient(135deg, ' + c + ' 0%, color-mix(in srgb, ' + c + ' 68%, black) 100%)',
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 28%, transparent), 0 1px 2px color-mix(in srgb, ' + c + ' 45%, transparent)',
        }}
      >
        {title.name}
      </span>
    );
  }

  if (variant === 'outline') {
    return (
      <span
        title={title.description ?? undefined}
        className={cn(base, 'border')}
        style={{
          color: c,
          borderColor: 'color-mix(in srgb, ' + c + ' 55%, transparent)',
          backgroundColor: 'color-mix(in srgb, ' + c + ' 10%, transparent)',
        }}
      >
        {title.name}
      </span>
    );
  }

  return (
    <span
      title={title.description ?? undefined}
      className={cn(base, 'text-white')}
      style={{
        backgroundColor: c,
        boxShadow:
          'inset 0 1px 0 color-mix(in srgb, white 30%, transparent), 0 0 10px color-mix(in srgb, ' + c + ' 55%, transparent)',
      }}
    >
      {title.name}
    </span>
  );
}
