import { useSearchParams } from 'react-router';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { LayoutGrid, List, Search, X } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { PAGE_LIMIT } from '@/lib/api/paging';
import { fetchTopics, searchTopics, type Topic as ApiTopic } from '@/lib/api/forum';
import { cn } from '@/lib/utils';
import { CompactTopicRow } from '@/devroom/pages/14-home/topic-compact-row';
import { SquareTopicCard } from '@/devroom/pages/14-home/topic-square-card';
import { ListEnd, SquareCardSkeleton } from '@/devroom/pages/14-home/states';

import { BoardRail, ComposeButton, PageHeader } from './_parts/layout';
import { Empty, ErrorState } from './_parts/state';
import { toCardTopic } from './_parts/mappers';

// 首页信息流（契约：GET /topics + GET /boards）。**公开首屏，不做代码分割**（前端方案 §6）。
// URL 即状态（§6 规则一）：board / sort / view 全在查询串里，可分享、可后退、刷新不丢。
// 卡片与紧凑行直接复用 DevRoom 14-home 的房子件（同一个实现，不是抄一份）。
const GRID = {
  card: 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
  compact: 'flex flex-col gap-0.5',
} as const;

type View = keyof typeof GRID;

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const board = params.get('board') ?? '';
  // 排序选项是**产品契约的一部分，不能来自设计房间的 mock**。
//
// 2026-10-13 用户实测：点「最热」整个列表报 **400 参数错误**。根因就是这个 import ——
// `@/devroom/pages/14-home/mock` 的 SORTS 里有第三个键 `hot`，而后端 `parseTopicSort` 只认 latest / new，
// 其余一律 `invalid("sort", "只能是 latest / new")`。设计稿的 mock 是「画出来给人看的」，不是契约。
//
// 「最热」要真正支持，缺的**不是一行**：schema 里没有任何热度列（like_count / reply_count / view_count 都是实时列），
// 而游标分页的键是 (排序列, id)、且排序列被当作**时间戳**用（`(t.last_reply_at, t.id) < ($1, $2)`）——
// 热度分不是时间，游标编码与索引都要跟着改。所以这一版**不提供**它，
// 也**不把它静默映射成 latest**（那会让用户以为自己在看最热，其实是按时间排的）。
const SORTS = [
  { key: 'latest', label: '最新回复' },
  { key: 'new', label: '最新发布' },
] as const;

const sort = (SORTS.find((s) => s.key === params.get('sort'))?.key ?? 'latest') as 'latest' | 'new';
  const view: View = params.get('view') === 'compact' ? 'compact' : 'card';

  const filter = { board: board || undefined, sort };
  const list = useInfiniteQuery({
    queryKey: qk.topics(filter),
    queryFn: ({ pageParam, signal }) => fetchTopics({ ...filter, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });

  // **搜索内嵌在首页**（用户明确要求「不要单独开一个页面」）：URL 里带 q 就把信息流切成搜索结果。
  // 用的是同一个端点（GET /search?type=topics）与同一张卡片，所以两种状态共用下面那一套渲染，
  // 不复制第二份列表。q 进 URL —— 可分享、可后退、刷新不丢（与 board / sort / view 同一条规则）。
  const q = (params.get('q') ?? '').trim();
  const [qInput, setQInput] = useState(q);
  const searching = q !== '';
  const searchFeed = useInfiniteQuery({
    queryKey: ['search', q],
    queryFn: ({ pageParam, signal }) => searchTopics(q, pageParam, signal),
    initialPageParam: null as string | null,
    enabled: searching,
    getNextPageParam: (last) => last.next,
  });
  const feed = searching ? searchFeed : list;

  const items: ApiTopic[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const total = items.length;

  /** 把输入框的值落到 URL；空串 = 退出搜索 */
  function commitQuery() {
    const v = qInput.trim();
    setParam('q', v === '' ? null : v);
  }

  /** 改 URL 里的一个键；null 表示删掉它（默认值不进 URL，链接才短） */
  function setParam(key: string, value: string | null) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }

  return (
    // 一维 flex 而不是写死两列的栅格：BoardRail 拿不到分区时**整个不渲染**，
    // 而栅格的第一条轨道照样占着 168px —— 主栏会被塞进那一格、文案逐字换行（出图时抓到的）。
    <div className='flex flex-col gap-6 xl:flex-row xl:items-start'>
      <BoardRail current={board || undefined} className='hidden xl:flex xl:w-[168px] xl:shrink-0' />

      <div className='flex min-w-0 flex-1 flex-col gap-4'>
        <PageHeader
          title='社区帖子'
          description={list.isSuccess ? '已加载 ' + total + ' 个帖子' : '浏览全部分区的最新帖子'}
          actions={<ComposeButton board={board || undefined} />}
        />

        <div className='flex flex-wrap items-center justify-between gap-2 border-y border-border py-2'>
          <span className='flex min-w-0 flex-1 items-center gap-2 sm:flex-none'>
            {/* 用原生 form 接 Enter：Ring 的 Input 没有 onPressEnter，而手写 onKeyDown 要赌它透传 DOM 属性 */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commitQuery();
              }}
              className='flex w-[260px] max-w-full items-center gap-2'
            >
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder='搜索帖子标题…'
                data-testid='home-search'
              />
              <Button type='submit' inline={false} height={ControlsHeight.S} icon={icon16(Search)}>
                搜索
              </Button>
            </form>
            {searching ? (
              <Button
                data-testid='home-search-clear'
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(X)}
                title='退出搜索，回到信息流'
                onClick={() => {
                  setQInput('');
                  setParam('q', null);
                }}
              >
                清除
              </Button>
            ) : null}
          </span>
          {/* 排序只对信息流有意义：搜索结果是按 rank 排的，给它一个「排序」开关是假的 */}
          {searching ? null : (
          <span className='flex items-center gap-2'>
            <span className='text-[12px] text-muted-foreground'>排序</span>
            <ButtonSet>
              {SORTS.map((s) => (
                <Button
                  key={s.key}
                  primary={s.key === sort}
                  ghost={s.key !== sort}
                  active={s.key === sort}
                  height={ControlsHeight.S}
                  onClick={() => setParam('sort', s.key === 'latest' ? null : s.key)}
                >
                  {s.label}
                </Button>
              ))}
            </ButtonSet>
          </span>
          )}
          <span className='flex items-center gap-2'>
            <span className='text-[12px] text-muted-foreground'>视图</span>
            <ButtonSet>
              {(['card', 'compact'] as const).map((v) => (
                <Button
                  key={v}
                  data-testid={'view-' + v}
                  active={v === view}
                  primary={v === view}
                  ghost={v !== view}
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(v === 'card' ? LayoutGrid : List)}
                  onClick={() => setParam('view', v === 'card' ? null : v)}
                >
                  {v === 'card' ? '卡片' : '紧凑列表'}
                </Button>
              ))}
            </ButtonSet>
          </span>
        </div>

        {feed.isPending ? (
          <ul className={cn('m-0 list-none p-0', GRID.card)} aria-busy>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <li key={i}>
                <SquareCardSkeleton />
              </li>
            ))}
          </ul>
        ) : feed.isError ? (
          <ErrorState what={searching ? '搜索结果' : '帖子列表'} error={feed.error} onRetry={() => void feed.refetch()} />
        ) : items.length === 0 ? (
          <Empty
            title={searching ? '没有匹配的帖子' : board ? '这个分区还没有帖子' : '还没有任何帖子'}
            hint={
              searching
                ? '换个词试试；搜索只查标题与正文里的字，不是模糊匹配。'
                : board
                  ? '换一个分区看看，或者成为第一个在这个分区发帖的人。'
                  : '站点刚开张时就是这样。第一篇帖子由你来写。'
            }
            action={
              searching ? (
                <Button onClick={() => { setQInput(''); setParam('q', null); }}>清除搜索</Button>
              ) : (
                <span className='flex flex-wrap items-center justify-center gap-2'>
                  {board ? <Button onClick={() => setParam('board', null)}>看全部帖子</Button> : null}
                  <ComposeButton board={board || undefined} />
                </span>
              )
            }
          />
        ) : (
          <>
            {view === 'card' ? (
              <ul className={cn('m-0 list-none p-0', GRID.card)}>
                {items.map((t) => (
                  <li key={t.id} className='flex'>
                    <SquareTopicCard
                      topic={toCardTopic(t)}
                      className='w-full'
                      href={appPath('t/' + encodeURIComponent(t.id))}
                      authorHref={appPath('u/' + encodeURIComponent(t.author.handle))}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div className={GRID.compact}>
                {items.map((t) => (
                  <CompactTopicRow
                    key={t.id}
                    topic={toCardTopic(t)}
                    href={appPath('t/' + encodeURIComponent(t.id))}
                  />
                ))}
              </div>
            )}

            {/* 游标分页（§21.1）：**没有页码**，只有 next_cursor 为 null 才算到底 */}
            {feed.hasNextPage ? (
              <div className='flex flex-col items-center gap-1.5'>
                <Button loader={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                  {feed.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
                <span className='text-[11px] text-muted-foreground'>
                  每页 {PAGE_LIMIT} 条 · 按游标翻页（不是页码）
                </span>
              </div>
            ) : (
              <ListEnd total={total} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
