import { SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 三态（骨架 / 空 / 到底）：**纯展示件**，交互由页面给（见 index.tsx）。
// 为什么自建：Ring UI 没有骨架与空状态（前端方案 §7.2 明确「骨架与空状态自建」）。

/** 方卡片骨架：刷子的块与真卡片同尺寸，数据回来时不跳版。 */
export function SquareCardSkeleton() {
  return (
    <div aria-hidden className='overflow-hidden rounded-lg border border-border bg-card'>
      <div className='aspect-video w-full animate-pulse bg-muted' />
      <div className='flex flex-col gap-2 p-2.5'>
        <span className='h-4 w-10 animate-pulse rounded-sm bg-muted' />
        <span className='h-4 w-full animate-pulse rounded-sm bg-muted' />
        <span className='h-4 w-3/5 animate-pulse rounded-sm bg-muted' />
        <span className='mt-1 flex items-center gap-1.5'>
          <span className='size-6 animate-pulse rounded-full bg-muted' />
          <span className='h-3 w-14 animate-pulse rounded-sm bg-muted' />
        </span>
      </div>
    </div>
  );
}

/** 紧凑行骨架：一行一块，不画分割线。 */
export function CompactRowSkeleton() {
  return (
    <div aria-hidden className='flex items-start gap-3 rounded-md px-3 py-2'>
      <span className='mt-0.5 size-6 shrink-0 animate-pulse rounded-full bg-muted' />
      <span className='flex min-w-0 flex-1 flex-col gap-1.5'>
        <span className='h-4 w-2/5 animate-pulse rounded-sm bg-muted' />
        <span className='h-3 w-4/5 animate-pulse rounded-sm bg-muted' />
      </span>
    </div>
  );
}

/** 空态：说清「为什么空」+ 给一条出路（清掉筛选）。 */
export function EmptyState({ title, hint, action, className }: { title: string; hint: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-14 text-center', className)}>
      <SearchX aria-hidden className='size-7 text-muted-foreground' />
      <span className='text-[15px] text-foreground'>{title}</span>
      <span className='max-w-[46ch] text-[13px] leading-relaxed text-muted-foreground'>{hint}</span>
      {action ? <span className='pt-1'>{action}</span> : null}
    </div>
  );
}

/** 到底文案（替代「加载更多」按钮）。 */
export function ListEnd({ total }: { total: number }) {
  return (
    <p className='m-0 py-6 text-center text-[12px] text-muted-foreground'>
      已经到底了 · 共 {total} 个主题（游标分页的 next_cursor 为 null 时显示这句，不再发请求）
    </p>
  );
}
