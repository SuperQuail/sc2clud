import Button from '@jetbrains/ring-ui-built/components/button/button';
import { appPath } from '@/lib/url';
import type { Board, BoardNav, BoardSlug } from './types';

// 左栏 = 分区列表 + 分区内导航。**只在 ≥1200px 出现**（贴吧式常驻栏），
// 所以宽度必须站得住：板名 + 计数 + 今日数三行内放下，字号不缩到 11px 以下。
// 分区是链接（导航）用 <a>；分区内导航是筛选，用 Ring UI Button（键盘与焦点归控件库管）。
// ring-1 而不是 border 表达选中：1px 描边不吃行高，切换分区时列表不会抖。
export function LeftRail({
  boards,
  currentSlug,
  nav,
  navValue,
  onNavChange,
}: {
  boards: Board[];
  currentSlug: BoardSlug;
  nav: BoardNav[];
  navValue: string;
  onNavChange: (key: string) => void;
}) {
  return (
    <div className='flex flex-col gap-5'>
      <section className='flex flex-col gap-1.5'>
        <h2 className='px-2 text-[11px] font-medium tracking-wide text-muted-foreground'>分区</h2>
        {boards.map((b) => {
          const current = b.slug === currentSlug;
          return (
            <a
              key={b.slug}
              href={appPath('b/' + b.slug)}
              aria-current={current ? 'page' : undefined}
              title={b.hint}
              className={
                'flex items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ' +
                (current ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-muted')
              }
            >
              <img src={b.cover} alt='' className='size-6 shrink-0 rounded-sm object-cover' />
              <span className='flex min-w-0 flex-1 flex-col'>
                <span className={'truncate text-[13px] ' + (current ? 'font-semibold text-primary' : 'text-foreground')}>
                  {b.name}
                </span>
                <span className='flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground'>
                  <span>{b.topic_count} 帖子</span>
                  {b.today_count > 0 ? <span>· 今日 {b.today_count}</span> : null}
                </span>
              </span>
            </a>
          );
        })}
      </section>

      <section className='flex flex-col gap-0.5 border-t border-border pt-4'>
        <h2 className='px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground'>分区内导航</h2>
        {nav.map((n) => {
          const current = n.key === navValue;
          return (
            <Button
              key={n.key}
              ghost
              active={current}
              aria-current={current ? 'true' : undefined}
              onClick={() => onNavChange(n.key)}
              className='w-full !justify-start px-2 text-[13px]'
            >
              <span className='inline-flex w-full items-baseline justify-between gap-2'>
                <span className='min-w-0 truncate'>{n.label}</span>
                <span className='shrink-0 tabular-nums text-[11px] text-muted-foreground'>{n.count}</span>
              </span>
            </Button>
          );
        })}
      </section>
    </div>
  );
}
