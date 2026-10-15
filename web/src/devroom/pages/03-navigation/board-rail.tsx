import type { ReactNode } from 'react';
import { imagePath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { DefaultCover } from '@/ui/topic/default-cover';

// 分区侧栏（首页 / 分区页共用）。**prop 驱动的 View**：只吃分区数组，不 fetch、不认路由表
// （清单 §0 的同源要求：DevRoom 03-navigation 与产品页渲染的是这同一个文件）。
//
// 分区身份按设计需求-分区页 §A：**名称、一句话简介、封面/图标**。侧栏是窄栏（168px），
// 所以封面用 20px 的小方块，简介放 title（悬停可见）。
//
// 封面字段是后端 BoardDTO 的 **cover_hash**（裸哈希，forum/internal/forum/dto.go:43）——
// 空串 = 这个分区没有封面，此时落**全站唯一那份默认封面**（@/ui/topic/default-cover）而不是空白，
// 也不再是「分区首字 + slug 色相」：用户 2026-10-15 判定那个字「完全没有关联」。
export type BoardSummary = {
  slug: string;
  name: string;
  /** BoardDTO 的 cover_hash：**裸哈希**，不是路径；空串 = 没有封面 */
  cover_hash: string;
  description?: string;
  topic_count?: number;
  /** BoardDTO 的 today_count：今天新发的帖子数。**只有分区页会用「今日 N」这一格**（t 弹提示里也用它） */
  today_count?: number;
};

/** 侧栏一行的封面位：有封面用图（图片端点），没有就用那份全站默认封面（静态素材）。 */
export function BoardCover({ hash, className }: { slug?: string; name?: string; hash?: string | null; className?: string }) {
  // hash 是**裸哈希**（后端 BoardDTO 给的形状）；房间是静态预览服务、没有 /img/{hash} 这条读口，
  // 所以也接住「已经是路径」的写法（以 / 开头），房间的演示数据用站内素材就能画出一张真封面。
  const src = hash ? imagePath(hash.startsWith('/') ? hash : '/img/' + hash) : null;
  return (
    <span className={cn('relative size-5 shrink-0 overflow-hidden rounded-[4px]', className)}>
      {src ? (
        <img src={src} alt='' loading='lazy' decoding='async' className='size-full object-cover' />
      ) : (
        <DefaultCover />
      )}
    </span>
  );
}

/**
 * 行的落地件由调用方给，**View 里不出现 react-router**：
 * 房间不在 RouterProvider 里（app.tsx 只认 ?page=），View 一旦 import react-router 就**渲染不了**
 * （实测：Cannot destructure property 'basename' of 's.useContext(...)' as it is null）
 * —— 与 10-messages 的 notice-center-view 同一条约定（那里也是把「点击改 URL」留在宿主）。
 * 缺省就是普通 `<a href>`（房间用），产品页传 react-router 的 Link（SPA 内跳，不整页刷新）。
 */
export type RailLink = (props: { href: string; className?: string; title?: string; 'aria-current'?: 'page'; children: ReactNode }) => ReactNode;

/** 缺省落地件：普通 `<a>`（房间与静态预览用；产品宿主传 react-router 的 Link）。 */
const PlainLink = 'a' as unknown as RailLink;

export function BoardRail({
  boards,
  current,
  className,
  link,
}: {
  boards: BoardSummary[];
  current?: string;
  className?: string;
  link?: RailLink;
}) {
  const Link = link ?? PlainLink;
  // 拿不到分区时**整块消失**而不是画骨架：它是辅助导航，不该在首屏抢走内容的注意力。
  if (boards.length === 0) return null;
  return (
    <nav aria-label='分区' className={cn('flex flex-col gap-0.5', className)}>
      <h2 className='px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground'>分区</h2>
      {boards.map((b) => {
        const isCurrent = b.slug === current;
        const cls = cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
          isCurrent ? 'bg-primary/10 font-semibold text-primary ring-1 ring-primary/40' : 'text-foreground hover:bg-muted',
        );
        const href = '/b/' + encodeURIComponent(b.slug);
        const title = b.description || b.name;
        const inner = (
          <>
            <BoardCover slug={b.slug} name={b.name} hash={b.cover_hash} />
            <span className='min-w-0 flex-1 truncate'>{b.name}</span>
            <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>{b.topic_count ?? 0}</span>
            {/* 「今日 N」：168px 的窄栏里只留得下「今日 + 数字」，有新增才画（0 不画 —— 一排 0 只是噪音）。
                与分区页那句「· 今日 N」（routes/board.tsx:101）同一个口径，数据都是 BoardDTO.today_count。 */}
            {b.today_count ? (
              <span className='shrink-0 text-[10px] tabular-nums text-primary/80'>今日 {b.today_count}</span>
            ) : null}
          </>
        );
        return isCurrent ? (
          <Link key={b.slug} href={href} className={cls} title={title} aria-current='page'>
            {inner}
          </Link>
        ) : (
          <Link key={b.slug} href={href} className={cls} title={title}>
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}
