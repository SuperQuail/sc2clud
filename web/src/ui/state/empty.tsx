import type { ReactNode } from 'react';
import { SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';

// 空态的**唯一实现**（2026-10-14 收口）。原先有两份逐字相同的类名与结构：
//   routes/_parts/state.tsx 的 Empty（产品页 8 处用）与 devroom/pages/14-home/states.tsx 的 EmptyState（房间 2 处用）。
// 放 src/ui 而不是 routes/_parts：两边都不欠对方一个人情，谁都能 import；
// _parts/state.tsx 继续 re-export 它，所以 8 个产品路由的 import 一行都不用改。
//
// 判据仍是「有没有数据」，所以判断留给调用方（query.isPending / isError / items.length），这里只管画。
// hint 可选：说不出「为什么空」时就别编一句（本仓库复盘：不实文案比缺文案更坏）。
export function Empty({
  title,
  hint,
  action,
  icon: Icon = SearchX,
  className,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: typeof SearchX;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-14 text-center',
        className,
      )}
    >
      <Icon aria-hidden className='size-7 text-muted-foreground' />
      <span className='text-[15px] text-foreground'>{title}</span>
      {hint ? <span className='max-w-[46ch] text-[13px] leading-relaxed text-muted-foreground'>{hint}</span> : null}
      {action ? <span className='pt-1'>{action}</span> : null}
    </div>
  );
}
