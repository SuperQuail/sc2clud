import type { ReactNode } from 'react';
import { Link } from 'react-router';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { fetchBoards } from '@/lib/api/forum';
import { cn } from '@/lib/utils';

// 页面级的两个小件（**不是控件**，是版式）：页头（标题 + 描述 + 动作）与分区侧栏。
// 它们放在 routes/_parts 而不是 src/ui：src/ui 是「控件库」，加控件要走 DevRoom 验证 + 登记
// （开发必读 §11），而这两个只是三四个页面的版式，不是控件。要提升成控件时先登记。

export function PageHeader({
  title,
  description,
  actions,
  backTo,
  backLabel,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 返回上一个列表（帖子页、设置页都要） */
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <header className='flex flex-wrap items-end justify-between gap-3'>
      <div className='flex min-w-0 flex-col gap-1'>
        {backTo ? (
          <Link
            to={backTo}
            className='inline-flex w-fit items-center gap-1 rounded-[3px] text-[12px] text-muted-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            <ArrowLeft aria-hidden className='size-3.5' />
            {backLabel ?? '返回'}
          </Link>
        ) : null}
        <h1 className='m-0 text-[20px] font-semibold text-foreground'>{title}</h1>
        {description ? <p className='m-0 text-[13px] text-muted-foreground'>{description}</p> : null}
      </div>
      {actions}
    </header>
  );
}

/** 发帖入口：全站只有这一处拼它的路径与图标（首页、分区页、帖子页都要一颗）。 */
export function ComposeButton({ board, label = '发帖' }: { board?: string; label?: string }) {
  return (
    <Button
      primary
      inline={false}
      height={ControlsHeight.M}
      icon={icon16(Plus)}
      href={appPath('new' + (board ? '?board=' + encodeURIComponent(board) : ''))}
    >
      {label}
    </Button>
  );
}

/**
 * 分区侧栏：只在一档窄宽度以上出现（贴吧式常驻左栏）。
 * 分区列表走 GET /boards（全站只有这一处请求它，staleTime 10 分钟在 lib/query/client.ts 里定）。
 * 拿不到分区时**整块消失**而不是画骨架：它是辅助导航，不该在首屏抢走内容的注意力。
 */
export function BoardRail({ current, className }: { current?: string; className?: string }) {
  const boards = useQuery({ queryKey: qk.boards(), queryFn: ({ signal }) => fetchBoards(signal), staleTime: 10 * 60_000 });
  if (!boards.data || boards.data.length === 0) return null;
  return (
    <nav aria-label='分区' className={cn('flex flex-col gap-0.5', className)}>
      <h2 className='px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground'>分区</h2>
      {boards.data.map((b) => {
        const isCurrent = b.slug === current;
        return (
          <Link
            key={b.slug}
            to={routePath('b/' + encodeURIComponent(b.slug))}
            aria-current={isCurrent ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              isCurrent ? 'bg-primary/10 font-semibold text-primary ring-1 ring-primary/40' : 'text-foreground hover:bg-muted',
            )}
          >
            <span className='min-w-0 flex-1 truncate'>{b.name}</span>
            <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>{b.topic_count}</span>
          </Link>
        );
      })}
    </nav>
  );
}
