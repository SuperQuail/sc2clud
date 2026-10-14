import { useSearchParams } from 'react-router';
import { Suspense, lazy, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { LayoutGrid, List } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { TopicRowData } from '@/ui/topic/topic-row';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { PAGE_LIMIT } from '@/lib/api/paging';
import { fetchTopics, searchTopics, type Topic as ApiTopic } from '@/lib/api/forum';
import { searchUsers } from '@/lib/api/user';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CompactTopicRow } from '@/devroom/pages/14-home/topic-compact-row';
import { SquareTopicCard } from '@/devroom/pages/14-home/topic-square-card';
import { ListEnd, SquareCardSkeleton } from '@/devroom/pages/14-home/states';
import { KIND_TAG, TOPIC_KIND_LABEL } from '@/devroom/pages/14-home/topic-kind';
import type { SearchState, SearchTab } from '@/devroom/pages/19-search/search-panel';

import { BoardRail, ComposeButton, PageHeader } from './_parts/layout';
import { Empty, ErrorState, GRID } from './_parts/state';
import { toCardTopic } from './_parts/mappers';

// 首页信息流（契约：GET /topics + GET /boards）。**公开首屏，不做代码分割**（前端方案 §6）。
// URL 即状态（§6 规则一）：board / sort / view 全在查询串里，可分享、可后退、刷新不丢。
// 卡片与紧凑行直接复用 DevRoom 14-home 的房子件（同一个实现，不是抄一份）。
// 搜索面板（19-search 的房子件）**懒加载**：它为了两档页签静态拖进了 Ring 的 Tabs →
// collapsible-tabs → list → react-virtualized + sniffr + combokeys —— 实测这一串占首屏 gzip **53.0 KB**
// （把 search-panel 换成空实现重打包：197.1 → 144.1），而首屏预算只有 150 KB。
// 那一整条链是给「可滚动的虚拟列表」用的，两块页签的搜索栏根本用不上。
// 照仓库既有的做法（12-topic/main-column 的评论区、report-dialog）走 lazy + Suspense。
const LazySearchPanel = lazy(() =>
  import('@/devroom/pages/19-search/search-panel').then((m) => ({ default: m.SearchPanel })),
);

// 懒加载期间的占位：形状照着 SearchPanel 的搜索栏 + 页签行画，**不能是空的** ——
// 空占位会让下面的信息流在 chunk 到达时往上跳一次（出图时看得见的那种抖动）。
function SearchPanelSkeleton() {
  return (
    <div className='flex flex-col gap-2' aria-hidden>
      <div className='h-8 w-full max-w-[520px] rounded-md border border-border bg-muted/40' />
      <div className='h-6 w-[220px] rounded-md bg-muted/40' />
    </div>
  );
}

type View = keyof typeof GRID;

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const board = params.get('board') ?? '';
  // 排序选项是**产品契约的一部分，不能来自设计房间的 mock**。
  //
  // 2026-10-13 用户实测：点「最热」整个列表报 **400 参数错误** —— 那时 `parseTopicSort` 只认 latest / new。
  // 2026-10-14（拍板 §L2）后端把它补上了（`score = (like_count + 3*顶层评论数) * time_boost`，
  // 游标键不再是时间、由服务端算好），所以这一档现在是**真能用的**，不再是假控件。
  // 三个 key 与 `lib/api/forum.ts` 的 `sort` 值域逐字一致 —— 改一处就要改另一处（类型会拦住）。
  const SORTS = [
    { key: 'latest', label: '最新回复' },
    { key: 'new', label: '最新发布' },
    { key: 'hot', label: '最热' },
  ] as const;

  const sort = (SORTS.find((s) => s.key === params.get('sort'))?.key ?? 'latest') as 'latest' | 'new' | 'hot';
  const view: View = params.get('view') === 'compact' ? 'compact' : 'card';

  // 搜索的**四个参数全在 URL 里**（q / type / 输入框草稿不进 URL，见下）：
  // 与 board / sort / view 同一条规则 —— 可分享、可后退、刷新不丢。
  const q = (params.get('q') ?? '').trim();
  const tab: SearchTab = params.get('type') === 'users' ? 'users' : 'topics';
  // 输入框是受控的草稿态；q 变了（后退、外链落地、点了清除）就跟着回填，否则用户看到的字与结果不是一回事
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const searching = q !== '';

  const filter = { board: board || undefined, sort };
  const list = useInfiniteQuery({
    queryKey: qk.topics(filter),
    queryFn: ({ pageParam, signal }) => fetchTopics({ ...filter, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });

  // **搜索内嵌在首页**（用户明确要求「不要单独开一个页面」）：URL 里带 q 就把信息流切成搜索结果。
  // 交付的是 DevRoom 19-search 的 <SearchPanel>（**同一个实现**，不是抄一份）：两档（帖子 / 用户）+ 四态。
  // 两档各一个查询、结果互不覆盖（切换页签不重新发请求）；结果按**已提交**的 q 算，不是每次击键。
  const searchFeed = useInfiniteQuery({
    queryKey: [...qk.search('topics', q), 'feed'],
    queryFn: ({ pageParam, signal }) => searchTopics(q, pageParam, signal),
    initialPageParam: null as string | null,
    enabled: searching,
    getNextPageParam: (last) => last.next,
  });
  // 用户档**没有游标**（searchUsers 的注释）：一次一页，上限 20。
  const userSearch = useQuery({
    queryKey: qk.search('users', q),
    queryFn: ({ signal }) => searchUsers(q, 20, signal),
    enabled: searching,
    staleTime: 30_000,
  });
  const feed = searching ? searchFeed : list;

  const items: ApiTopic[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const total = items.length;

  // 四态：idle 只有「还没搜过」；可见的那一档在加载中就 loading；失败给 error（带后端的话）。
  // **不做输入即搜**：结果只跟 URL 里的 q 走，否则每敲一个字都是一次请求。
  const active = tab === 'topics' ? searchFeed : userSearch;
  const searchState: SearchState = !searching
    ? 'idle'
    : active.isError
      ? 'error'
      : active.isPending
        ? 'loading'
        : 'ready';

  // **只把当前档的结果交给面板**：两档是同一个位置的两份数据，串档会让一次搜索结果出现在另一档里
  // （react-query 的 data 缓存住上一次的响应，切回主题档时那一瞬看到的是用户档的结果）。
  const topicRows: TopicRowData[] = tab === 'topics' ? toSearchRows(items) : [];
  // 用户档：接口的 SearchItem.id 是**数字 user id**（提及的真源），而 19-search 设计件的
  // 那一份类型 id 是展示用的串（它的假数据是 'u_01'）。这一层只做形状转换 —— 与 topics 档
  // 走 toTopicRow 是同一条规矩（设计件不认识接口类型）。
  const userRows =
    tab === 'users'
      ? (userSearch.data ?? []).map((u) => ({ ...u, id: String(u.id) }))
      : [];

  /** 把输入框的值落到 URL；空串 = 退出搜索 */
  function commitQuery() {
    const v = draft.trim();
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

        {/* 搜索那一块是 DevRoom 19-search 的 <SearchPanel>（登记在 registry，注释写明「真站把搜索内嵌在首页」）。
            它自带搜索栏、两档页签、四态与窄屏折叠，所以这里不再手写第二份搜索行。 */}
        <Suspense fallback={<SearchPanelSkeleton />}>
          <LazySearchPanel
            q={draft}
            onQChange={setDraft}
            onSubmit={commitQuery}
          onClear={() => {
            setDraft('');
            setParam('q', null);
          }}
          tab={tab}
          onTabChange={(next) => setParam('type', next === 'users' ? 'users' : null)}
          state={searchState}
          topics={topicRows}
          users={userRows}
            error={searchState === 'error' ? errorText(active.error) : undefined}
            onRetry={() => void Promise.all([searchFeed.refetch(), userSearch.refetch()])}
          />
        </Suspense>
        {/* 帖子档的「加载更多」：SearchPanel 只画结果，翻页由调用方给 —— 一次只发下一个游标请求。
            用户档没有游标，所以这里不会出现。 */}
        {searching && tab === 'topics' ? (
          searchFeed.hasNextPage ? (
            <div className='flex flex-col items-center gap-1.5'>
              <Button loader={searchFeed.isFetchingNextPage} onClick={() => void searchFeed.fetchNextPage()}>
                {searchFeed.isFetchingNextPage ? '加载中…' : '加载更多搜索结果'}
              </Button>
              <span className='text-[11px] text-muted-foreground'>搜索按 (rank, id) 排，游标自带档位</span>
            </div>
          ) : items.length > 0 ? (
            <ListEnd total={items.length} />
          ) : null
        ) : null}

        {/* 排序与视图**只对信息流有意义**：搜索结果是按 rank 排的、由 SearchPanel 自己排版，
            给它们一个开关是假控件。搜索时这两组整体不渲染。 */}
        {searching ? null : (
        <div className='flex flex-wrap items-center justify-between gap-2 border-y border-border py-2'>
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
        )}

        {/* **搜索结果只由 SearchPanel 渲染**（它自带四态、空态与「加载更多」是另一回事）：
            搜索结果不像信息流那样翻页 —— 帖子档的 rank 游标交给 SearchPanel 上方的分页按钮，
            用户档根本没有游标。这里只在**没搜索**时渲染信息流，避免同一批结果出现两次。 */}
        {searching ? null : feed.isPending ? (
          <ul className={cn('m-0 list-none p-0', GRID.card)} aria-busy>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <li key={i}>
                <SquareCardSkeleton />
              </li>
            ))}
          </ul>
        ) : feed.isError ? (
          <ErrorState what='帖子列表' error={feed.error} onRetry={() => void feed.refetch()} />
        ) : items.length === 0 ? (
          <Empty
            title={board ? '这个分区还没有帖子' : '还没有任何帖子'}
            hint={
              board
                ? '换一个分区看看，或者成为第一个在这个分区发帖的人。'
                : '站点刚开张时就是这样。第一篇帖子由你来写。'
            }
            action={
              <span className='flex flex-wrap items-center justify-center gap-2'>
                {board ? <Button onClick={() => setParam('board', null)}>看全部帖子</Button> : null}
                <ComposeButton board={board || undefined} />
              </span>
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

// 搜索结果行的映射。**与 DevRoom data.ts 的 toTopicRow 是同一件事**，但那个文件把结果映射进
// TopicRowData 时用的是房间里的 mock 形状（topic.author.avatar 已经是 URL）；产品这边拿到的是后端
// DTO，所以作者头像要先过 mappers 的 toCardTopic（hash → /img/<hash>）。
// 标签用**帖子类型**（讨论/资源/转载）——搜索结果里不显示分区，那样一行会有两个 Tag 抢注意力。
function toSearchRows(items: ApiTopic[]): TopicRowData[] {
  return items.map((t) => {
    const c = toCardTopic(t);
    return {
      id: c.id,
      title: c.title,
      tags: [{ text: TOPIC_KIND_LABEL[c.kind], type: KIND_TAG[c.kind] }],
      author: {
        nickname: c.author.nickname,
        avatar: c.author.avatar,
        role: c.author.role ?? null,
        title: c.author.title ?? null,
      },
      replies: c.reply_count,
      views: c.view_count,
      lastReplyAt: formatTime(c.last_reply_at),
      href: appPath('t/' + encodeURIComponent(c.id)),
    };
  });
}

/** 错误态要一句人话：后端的 message 比 String(err) 有用（ErrorState 里也是这条口径）。 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : '搜索失败，请重试。';
}
