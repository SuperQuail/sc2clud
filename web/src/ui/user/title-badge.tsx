import { cn } from '@/lib/utils';

// 头衔徽标。**独立控件**：头衔是运营/活动给的称号（可自定义颜色），与权限是两回事。
export type UserTitle = { name: string; color?: string | null };

export function TitleBadge({ title, className }: { title: UserTitle; className?: string }) {
  const color = title.color ?? 'var(--primary)';
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', className)}
      style={{ color, backgroundColor: 'color-mix(in srgb, ' + color + ' 14%, transparent)' }}
    >
      {title.name}
    </span>
  );
}
