import { cn } from '@/lib/utils';

// 头衔控件。数据来自 titles 表：key / name / color / description；用户只佩戴一个。
// 差异化的三套设计（与权限配对评估，见 DevRoom 07）：
//   1 圆润胶囊      全圆角 + 描边 + 浅底；与方角的权限形成形状对立
//   2 描边无底      只有边框与彩色文字；比权限轻，但形状不同（圆角矩形 vs 竖线）
//   3 下划彩线      无底色无边框，文字下方一条彩线；最轻，像「称号」
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
  const base = cn('inline-flex shrink-0 items-center font-semibold whitespace-nowrap', SIZE[size], className);

  if (design === 2) {
    return (
      <span className={cn(base, 'rounded-[5px] border px-1.5 py-0.5')} style={{ color: c, borderColor: c }}>
        {title.name}
      </span>
    );
  }

  if (design === 3) {
    return (
      <span className={cn(base, 'border-b-2 pb-px')} style={{ color: c, borderColor: c }}>
        {title.name}
      </span>
    );
  }

  return (
    <span
      className={cn(base, 'rounded-full border px-2 py-0.5')}
      style={{ color: c, borderColor: 'color-mix(in srgb, ' + c + ' 55%, transparent)', backgroundColor: 'color-mix(in srgb, ' + c + ' 10%, transparent)' }}
    >
      {title.name}
    </span>
  );
}
