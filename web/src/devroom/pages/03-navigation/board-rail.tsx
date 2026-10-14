import { Link } from 'react-router';
import { imagePath, routePath } from '@/lib/url';
import { cn } from '@/lib/utils';

// 分区侧栏（首页 / 分区页共用）。**prop 驱动的 View**：只吃分区数组，不 fetch、不认路由表
// （清单 §0 的同源要求：DevRoom 03-navigation 与产品页渲染的是这同一个文件）。
//
// 分区身份按设计需求-分区页 §A：**名称、一句话简介、封面/图标**。侧栏是窄栏（168px），
// 所以封面用 20px 的小方块，简介放 title（悬停可见）。
//
// 封面字段是后端 BoardDTO 的 **cover_hash**（裸哈希，forum/internal/forum/dto.go:43）——
// 空串 = 这个分区没有封面，此时落一个**稳定的占位**（首字 + 由 slug 定的色相）而不是空白。
// 稳定：同一个分区每次都是同一个色，与 @/ui/user/avatar 的取色同一套公式。
export type BoardSummary = {
  slug: string;
  name: string;
  /** BoardDTO 的 cover_hash：**裸哈希**，不是路径；空串 = 没有封面 */
  cover_hash: string;
  description?: string;
  topic_count?: number;
};

const HUES = [212, 262, 330, 12, 152, 190];
function hueOf(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 100000;
  return HUES[h % HUES.length]!;
}

/** 侧栏一行的封面位：有封面用图，没有就用「首字 + slug 色相」的稳定占位。 */
export function BoardCover({ slug, name, hash, className }: { slug: string; name: string; hash?: string | null; className?: string }) {
  return (
    <span
      className={cn('grid size-5 shrink-0 place-items-center overflow-hidden rounded-[4px] text-[11px] font-semibold text-white select-none', className)}
      style={hash ? undefined : { background: 'hsl(' + hueOf(slug) + ' 62% 46%)' }}
    >
      {hash ? (
        <img src={imagePath('/img/' + hash)} alt='' loading='lazy' decoding='async' className='size-full object-cover' />
      ) : (
        <span aria-hidden>{[...name][0] ?? '?'}</span>
      )}
    </span>
  );
}

export function BoardRail({ boards, current, className }: { boards: BoardSummary[]; current?: string; className?: string }) {
  // 拿不到分区时**整块消失**而不是画骨架：它是辅助导航，不该在首屏抢走内容的注意力。
  if (boards.length === 0) return null;
  return (
    <nav aria-label='分区' className={cn('flex flex-col gap-0.5', className)}>
      <h2 className='px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground'>分区</h2>
      {boards.map((b) => {
        const isCurrent = b.slug === current;
        return (
          <Link
            key={b.slug}
            to={routePath('b/' + encodeURIComponent(b.slug))}
            aria-current={isCurrent ? 'page' : undefined}
            title={b.description || b.name}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              isCurrent ? 'bg-primary/10 font-semibold text-primary ring-1 ring-primary/40' : 'text-foreground hover:bg-muted',
            )}
          >
            <BoardCover slug={b.slug} name={b.name} hash={b.cover_hash} />
            <span className='min-w-0 flex-1 truncate'>{b.name}</span>
            <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>{b.topic_count ?? 0}</span>
          </Link>
        );
      })}
    </nav>
  );
}
