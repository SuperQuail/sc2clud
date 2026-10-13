import type { ReactNode } from 'react';

// 通知列表容器：卡片 + 标题 + 内容 + 空态。业务内容由 children 给。
export function NoticeList({
  title,
  hint,
  empty,
  children,
}: {
  title: string;
  hint?: string;
  /** 没有数据时显示的东西（默认给一句通用空态） */
  empty?: ReactNode;
  children?: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section data-testid='notice-list' className='flex flex-col overflow-hidden rounded-lg border border-border bg-background'>
      <header className='flex flex-wrap items-baseline gap-2 border-b border-border px-4 py-3'>
        <h2 className='text-[15px] font-semibold text-foreground'>{title}</h2>
        {hint ? <span className='text-[13px] text-muted-foreground'>{hint}</span> : null}
      </header>
      {/* min-h-0 是必须的：父级给固定高度做「内部滚动」时，flex 子项的默认 min-height:auto 会让它被裁掉而不是滚动。
          任何用它的页面都只能各自绕，所以修在共享件里。 */}
      {hasChildren ? (
        <div className='flex min-h-0 flex-1 flex-col overflow-y-auto'>{children}</div>
      ) : (
        <div className='flex flex-col items-center gap-2 px-4 py-12 text-center'>
          {empty ?? (
            <>
              <span className='text-[15px] text-foreground'>还没有内容</span>
              <span className='text-[13px] text-muted-foreground'>有新消息时会出现在这里</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}
