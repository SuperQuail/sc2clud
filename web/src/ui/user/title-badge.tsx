import { cn } from '@/lib/utils';

// 头衔控件（titles 表；一人只佩戴一个）。同样全部用「带颜色的半透明背景」，三套做法：
//   1 半透明底 + 同色细描边（outline 感）
//   2 半透明底 + 全圆胶囊
//   3 半透明底 + 底部色条（不用边框，靠底部一条线区分）
export type TitleDesign = 1 | 2 | 3;
export type UserTitle = { key?: string; name: string; color?: string | null; description?: string | null };
const SIZE = { sm: 'text-[11px]', md: 'text-xs', lg: 'text-sm' } as const;

export function TitleBadge({
  title,
  design = 1,
  size = 'md',
  className,
}: {
  title: UserTitle;
  design?: TitleDesign;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const c = title.color ?? 'var(--primary)';
  const bg = { backgroundColor: 'color-mix(in srgb, ' + c + ' 12%, transparent)', color: c };
  const base = cn('inline-flex shrink-0 items-center font-medium whitespace-nowrap', SIZE[size], className);

  if (design === 2) {
    return (
      <span className={cn(base, 'rounded-full px-2 py-0.5 font-semibold')} style={bg}>
        {title.name}
      </span>
    );
  }

  if (design === 3) {
    return (
      <span className={cn(base, 'rounded-t-[3px] border-b-2 px-1.5 py-0.5')} style={{ ...bg, borderColor: c }}>
        {title.name}
      </span>
    );
  }

  return (
    <span
      className={cn(base, 'rounded-[3px] border px-1.5 py-0.5')}
      style={{ ...bg, borderColor: 'color-mix(in srgb, ' + c + ' 45%, transparent)' }}
    >
      {title.name}
    </span>
  );
}
