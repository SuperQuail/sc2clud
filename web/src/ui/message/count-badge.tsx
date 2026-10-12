import { cn } from '@/lib/utils';

// 数字角标（导航项上的「收到的赞 3」这种）。Ring 没有 Badge 件，所以自建——
// 它是一块**展示件**（不可点、不接收交互），不违反「控件一律走库」的约定。
// 三位数以上收成 99+，避免把导航挤变形。
export function CountBadge({
  count,
  max = 99,
  className,
}: {
  count: number;
  max?: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      data-testid='count-badge'
      className={cn(
        'inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] leading-[1.4] font-medium text-background tabular-nums',
        className,
      )}
    >
      {count > max ? max + '+' : count}
    </span>
  );
}
