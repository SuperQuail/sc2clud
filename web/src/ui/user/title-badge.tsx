import { cn } from '@/lib/utils';

// 头衔控件。数据来自 titles 表：key / name / color / description；用户只佩戴一个（equipped_title_id）。
// 样式已定稿为 outline（描边 + 浅底 + 同色文字，无图标）；之前的 plain/gradient/glow 三版已删除。
const SIZE = { sm: 'text-[11px]', md: 'text-xs', lg: 'text-sm' } as const;

export type UserTitle = { key?: string; name: string; color?: string | null; description?: string | null };

export function TitleBadge({
  title,
  size = 'md',
  className,
}: {
  title: UserTitle;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const c = title.color ?? 'var(--primary)';
  return (
    <span
      title={title.description ?? undefined}
      className={cn(
        'inline-flex shrink-0 items-center rounded-[5px] border px-1.5 py-0.5 font-semibold whitespace-nowrap',
        SIZE[size],
        className,
      )}
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
