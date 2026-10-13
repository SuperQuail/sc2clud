import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useState } from 'react';
import { Eraser, LayoutGrid, List, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { CompactTopicRow } from './topic-compact-row';
import { SquareTopicCard } from './topic-square-card';
import { CompactRowSkeleton, EmptyState, ListEnd, SquareCardSkeleton } from './states';
import { BOARDS, SORTS, TOPICS, filterByBoard, type SortKey, type Topic } from './mock';
import { appPath } from '@/lib/url';
import { roomHref } from '@/devroom/room-links';

// DevRoom 14 · 主页面（信息流）
// 交付：① 新增的**方卡片**（16:9 封面，grid ≥4 列）；② 第一版的**横板缩略卡片**留在同页做对照；
//       ③ 卡片 ⇄ 紧凑列表切换；④ 页面上下补齐真实站点该有的内容（分区筛选 / 排序 / 加载更多 / 三态）。
//
// 一屏 ≥4 张的口径：**项宽响应式**（Tailwind 的 sm/lg/xl 断点）——1280 视口 → xl → 4 列。
// 本页在 DevRoom 里只占内容区（1440 视口下内容区 1060px，四列各 256px）；
// 产品站 1280–1440 这一档是「贴吧式常驻左栏」，信息流拿到的宽度更小，所以卡片走 w-full 由栅格定宽。
const GRID: Record<View, string> = {
  card: 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
  compact: 'flex flex-col gap-0.5',
};

type View = 'card' | 'compact';

// 分段控件的统一形态：**三组（分区筛选 / 排序 / 视图）同一套** —— 无框 + 选中态一眼看得出来。
// 选中态：用**库自带的变体**表达（选中 = primary 实心，未选中 = ghost 无框次要）。
// 为什么不用 className 加强：实测 **这两种写法没被生成**——
// `[&.ring-button-active]:bg-primary/12` 与 `data-[state=on]:bg-primary/12` 写上去后，
// 元素上有类名、控制台无报错、但样式表里没有对应规则（computed background 原样不变）。
// 边界：**不是「所有方括号变体都不行」**（`[&>*]:flex-1` 这类是被生成过的），是这两个具体形式在本项目没生成；
// 下次要用别的方括号变体，先看产物 CSS 里有没有那条规则，再决定。
// 所以这里用 primary/ghost 两个库变体做对比，既满足「选中一眼看得出来」，也不碰库变量。

const VIEWS: Array<{ key: View; label: string; icon: typeof LayoutGrid }> = [
  { key: 'card', label: '卡片', icon: LayoutGrid },
  { key: 'compact', label: '紧凑列表', icon: List },
];

// ?view= 与将来的 useSearchParams：DevRoom 没有 router（它只认 ?page=），所以这里是**页面内的受控状态**。
// 切到产品路由时只有这一处要改：
//   const [params, setParams] = useSearchParams();
//   const view = params.get('view') === 'compact' ? 'compact' : 'card';
//   const setView = (v: View) => setParams((p) => { p.set('view', v); return p; }, { replace: true });
// 分区（?board=）、排序（?sort=）、游标（?cursor=）将来同样进 URL（前端方案 §6「URL 即状态」）。
// 深链支持（?view=compact）：只在挂载时读一次 URL，之后由状态驱动（真页面里这一段就是 useSearchParams 的初始值）
function viewFromUrl(): View {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'compact' ? 'compact' : 'card';
}

function sortTopics(list: Topic[], sort: SortKey): Topic[] {
  const copy = [...list];
  if (sort === 'new') return copy.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  // 契约 §21.1：v1 的 hot 由 service 定公式，前端只透传 sort=hot——这里的排序只是让对照页看得出差别
  if (sort === 'hot') return copy.sort((a, b) => b.reply_count - a.reply_count);
  return copy.sort((a, b) => Date.parse(b.last_reply_at) - Date.parse(a.last_reply_at));
}

export default function HomePage() {
  const [board, setBoard] = useState('all');
  const [sort, setSort] = useState<SortKey>('latest');
  const [view, setView] = useState<View>(viewFromUrl);
  const [shown, setShown] = useState(8);
  // 空态：本页数据都是造出来的，所以用一个开关模拟「这个分区没帖子」
  const [emptyCase, setEmptyCase] = useState(false);

  const matched = emptyCase ? [] : sortTopics(filterByBoard(TOPICS, board), sort);
  const visible = matched.slice(0, shown);
  const hasMore = shown < matched.length;
  const boardLabel = BOARDS.find((b) => b.key === board)?.label ?? '全部';
  const first = TOPICS[0]!;

  return (
    <div className='flex flex-col gap-4'>
      {/* 分区身份行：真实分区页有封面与统计，这里只留信息流需要的那一条 */}
      <section className='flex flex-wrap items-end justify-between gap-3'>
        <div>
          <h1 className='m-0 text-[20px] font-semibold text-foreground'>战役社区 · {boardLabel}</h1>
          <p className='m-0 text-[13px] text-muted-foreground'>{matched.length} 个帖子 · 今日新增 12 · 关注 3,204</p>
        </div>
        {/* 发帖 → 18-compose。**房间内链接只能走 ?page=**（旧站域名下的 /p/xxx、/settings 会 404，
            盲审一号报的就是这个）。
            **不带 ?board=**：本页的分区是「信息流筛选项」的键（campaign / terrain / help …），与发帖页
            要的 BoardSlug（custom-campaign …，见 12-topic/types.ts）不是同一套 —— 实测带过去一律被发帖页
            判成非法值、静默回落到默认分区（?board=help 与不带参数的出图**逐像素相同**，2026-10-13 量过）。
            两套键统一之后再带上，那时这里才有意义。 */}
        <Button
          primary
          inline={false}
          height={ControlsHeight.M}
          icon={icon16(Plus)}
          href={appPath('?page=18-compose')}
        >
          发帖
        </Button>
      </section>

      {/* 分区筛选行：数据驱动的分段按钮（BOARDS 决定有几个），不是写死的 if 链 */}
      <ButtonSet className='flex-wrap gap-1'>
        {BOARDS.map((b) => (
          <Button
            key={b.key}
            primary={b.key === board}
            ghost={b.key !== board}
            active={b.key === board}
            height={ControlsHeight.S}
            onClick={() => {
              setBoard(b.key);
              setEmptyCase(false);
            }}
          >
            {b.label}
          </Button>
        ))}
      </ButtonSet>

      {/* 排序行 + 视图切换：一排两个控件，小屏折行 */}
      <div className='flex flex-wrap items-center justify-between gap-2 border-y border-border py-2'>
        <span className='flex items-center gap-2'>
          <span className='text-[12px] text-muted-foreground'>排序</span>
          {/* 分段控件统一形态：**无框 + 选中态浅底**（用户明确要求去掉边框）。
              排序组与右边的视图组必须同一套写法，否则并排看就是「两组拼在一起」。 */}
          <ButtonSet>
            {SORTS.map((s) => (
              <Button key={s.key} primary={s.key === sort} ghost={s.key !== sort} active={s.key === sort} height={ControlsHeight.S} onClick={() => setSort(s.key)}>
                {s.label}
              </Button>
            ))}
          </ButtonSet>
        </span>

        <span className='flex items-center gap-2'>
          <span className='text-[12px] text-muted-foreground'>视图</span>
          {/* 与左边的排序组同一套写法（ghost + 选中态浅底）：两组并排，必须像一组控件 */}
          <ButtonSet>
            {VIEWS.map((v) => (
              <Button
                key={v.key}
                data-testid={'view-' + v.key}
                active={v.key === view}
                primary={v.key === view}
                ghost={v.key !== view}
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(v.icon)}
                onClick={() => setView(v.key)}
              >
                {v.label}
              </Button>
            ))}
          </ButtonSet>
          <Button
            data-testid='toggle-empty'
            icon={icon16(Eraser)}
            height={ControlsHeight.S}
            aria-label={emptyCase ? '恢复列表' : '模拟空态'}
            title={emptyCase ? '恢复列表' : '模拟空态'}
            onClick={() => setEmptyCase((v) => !v)}
          />
        </span>
      </div>

      {matched.length === 0 ? (
        <EmptyState
          title='这个分区还没有帖子'
          hint={'当前筛选：' + boardLabel + '。换一个分区，或者成为第一个发帖的人。'}
          action={
            <Button
              onClick={() => {
                setBoard('all');
                setEmptyCase(false);
              }}
            >
              看全部帖子
            </Button>
          }
        />
      ) : view === 'card' ? (
        <ul className={cn('m-0 list-none p-0', GRID.card)}>
          {visible.map((t) => (
            <li key={t.id} className='flex'>
              {/* href 由调用方给（2026-10-13 起）：产品路由传 appPath('t/'+id)，房间传 ?page=12-topic */}
              <SquareTopicCard topic={t} className='w-full' href={roomHref('12-topic')} authorHref={roomHref('11-profile')} />
            </li>
          ))}
        </ul>
      ) : (
        <div className={GRID.compact}>
          {visible.map((t) => (
            <CompactTopicRow key={t.id} topic={t} href={roomHref('12-topic')} />
          ))}
        </div>
      )}

      {matched.length > 0 && hasMore ? (
        <div className='flex flex-col items-center gap-1.5'>
          <Button onClick={() => setShown((n) => n + 4)}>{'加载更多（还剩 ' + (matched.length - shown) + ' 条）'}</Button>
          <span className='text-[11px] text-muted-foreground'>游标分页：带 next_cursor 再请求，不用页码</span>
        </div>
      ) : null}
      {matched.length > 0 && !hasMore ? <ListEnd total={matched.length} /> : null}

      {/* 对照：第一版横板缩略卡片（标题 + 摘要 + 作者 + 统计，横向一条）。留着比对，别再写第二份 */}
      <section className='flex flex-col gap-2'>
        <h2 className='m-0 text-[14px] font-semibold text-foreground'>对照：第一版横板缩略卡片</h2>
        <div className='flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5'>
          <span className='relative aspect-video w-[112px] shrink-0 overflow-hidden rounded-md border border-border bg-muted'>
            {first.cover ? (
              <img src={first.cover} alt='' loading='lazy' decoding='async' className='absolute inset-0 size-full object-cover' />
            ) : null}
          </span>
          <div className='flex min-w-0 flex-1 flex-col gap-1'>
            <a
              href={roomHref('12-topic')}
              className='min-w-0 truncate rounded-[3px] text-[15px] font-medium text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
            >
              {first.title}
            </a>
            <p className='m-0 line-clamp-2 text-[12.5px] leading-[1.5] text-muted-foreground'>{first.excerpt}</p>
            <span className='flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground'>
              <span className='flex items-center gap-1'>
                <UserAvatar name={first.author.nickname} src={first.author.avatar} size='sm' />
                <Username nickname={first.author.nickname} size='sm' />
              </span>
              <span className='tabular-nums'>
                {first.reply_count} 回复 · {first.like_count} 赞 · {first.view_count} 浏览
              </span>
            </span>
          </div>
        </div>
      </section>

      {/* 状态对照：骨架（与真卡片同尺寸的占位）与空态。真页面同一时刻只有一个态，这里并列是为了同屏比对；
          点右上角的刷新按钮可以切到「空态」。 */}
      <section className='flex flex-col gap-2'>
        <h2 className='m-0 text-[14px] font-semibold text-foreground'>状态对照：骨架 / 空态</h2>
        <div className='grid gap-4 lg:grid-cols-[1.4fr_1fr]'>
          <ul className='m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3'>
            <li>
              <SquareCardSkeleton />
            </li>
            <li>
              <SquareCardSkeleton />
            </li>
            <li>
              <SquareCardSkeleton />
            </li>
          </ul>
          <div className='flex flex-col gap-2'>
            <EmptyState
              title='这个分区还没有帖子'
              hint='空态文案与上面的真空态共用同一个件；这里只是把两种态同屏摆出来。'
              action={<Button onClick={() => setEmptyCase(true)}>看空态（把列表清空）</Button>}
            />
            <div className='rounded-lg border border-border bg-card p-0.5'>
              <CompactRowSkeleton />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}