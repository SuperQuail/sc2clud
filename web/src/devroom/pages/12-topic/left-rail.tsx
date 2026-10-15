import Button from '@jetbrains/ring-ui-built/components/button/button';
import { BoardRail, type BoardSummary, type RailLink } from '@/devroom/pages/03-navigation/board-rail';
import type { BoardNav, BoardSlug } from './types';

// 左栏 = 分区列表 + 分区内导航。**只在 ≥1200px 出现**（贴吧式常驻栏）。
// 分区内导航是筛选，用 Ring UI Button（键盘与焦点归控件库管）；
// 分区列表**不再自己画**：它就是 03-navigation 的 BoardRail（首页 / 分区页 / 帖子页同一个文件）。
//
// 这里原来又写了一份分区行，读的是设计稿的 `cover` —— 而 BoardDTO 里根本没有这一列（真名是 cover_hash），
// 于是真站恒为空、恒灰块（D21：2026-10-15 用户实测「帖子页内左侧依旧不显示分区封面」）。
// 两处封面逻辑（占位、/img/ 前缀、悬停提示）也就此只剩一份。
export function LeftRail({
  boards,
  currentSlug,
  nav,
  navValue,
  onNavChange,
  link,
}: {
  boards: BoardSummary[];
  currentSlug: BoardSlug;
  nav: BoardNav[];
  navValue: string;
  onNavChange: (key: string) => void;
  /** 行的落地件由宿主给（View 里不出现 react-router）：产品传 Link，房间传不可导航的 span */
  link?: RailLink;
}) {
  return (
    <div className='flex flex-col gap-5'>
      <BoardRail boards={boards} current={currentSlug} link={link} />

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
                {/* 数字拿不到时（真站：后端没有分筛选计数）只留标签，不写一个会骗人的 0 */}
                {n.count != null ? (
                  <span className='shrink-0 tabular-nums text-[11px] text-muted-foreground'>{n.count}</span>
                ) : null}
              </span>
            </Button>
          );
        })}
      </section>
    </div>
  );
}
