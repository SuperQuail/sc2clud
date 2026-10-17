import { Link, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { PAGE_LIMIT } from '@/lib/api/paging';
import { fetchBoard, fetchTopics, type Topic as ApiTopic } from '@/lib/api/forum';
import { fetchBoardFollowers, fetchBoardFollow, followBoard, unfollowBoard } from '@/lib/api/follow';
import { useSession } from '@/lib/perms';
import { ArrowLeft, LayoutGrid, List, Star, UserPlus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { cn } from '@/lib/utils';
import { CompactTopicRow } from '@/devroom/pages/14-home/topic-compact-row';
import { SquareTopicCard } from '@/devroom/pages/14-home/topic-square-card';
import { ListEnd, SquareCardSkeleton } from '@/devroom/pages/14-home/states';
import { BoardRail, ComposeButton, PageHeader } from './_parts/layout';
import { Empty, ErrorState, GRID } from './_parts/state';
import { toCardTopic } from './_parts/mappers';
import { UserFollowList } from './_parts/follow-lists';

// 分区页（契约：GET /boards/{slug} + GET /topics?board=<slug>）。
// 分区身份（简介 / 统计）来自 board 详情，列表来自 topics；两块各自三态，
// 分区信息失败**不挡住列表** —— 「谁的信息没拿到」要说清楚，而不是整页白屏。
//
// 信息流那一套（卡片 ⇄ 紧凑列表）与首页**是同一份房子件、同一套 URL 状态**（14-home 的
// SquareTopicCard / CompactTopicRow + ?view=）。分区页与首页看起来必须是同一个站。
// 已知缺口：分区内导航（全部/精华/资源/讨论/公告）需要后端的 kind/featured 筛选，
// 目前只有 §21.2 的 kind 能对上，所以这一版只保留 kind 筛选，其余记进回报的端点清单。
const KINDS = [
  { key: '', label: '全部' },
  { key: 'discussion', label: '讨论' },
  { key: 'resource', label: '资源' },
  { key: 'repost', label: '转载' },
] as const;

export function BoardPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const session = useSession();
  const kind = params.get('kind') ?? '';
  const view = params.get('view') === 'compact' ? 'compact' : 'card';
  // 关注（L5）：**未登录也能读**（following 恒 false、关注数照给）—— 那格「关注」不是登录用户专属信息。
  // 关注/取关是幂等的，回执就是同一份 State，所以成功之后直接写进缓存，不回读一次。
  const follow = useQuery({
    queryKey: qk.followBoard(slug),
    queryFn: ({ signal }) => fetchBoardFollow(slug, signal),
    enabled: slug !== '',
    staleTime: 60_000,
  });
  const toggleFollow = useMutation({
    mutationFn: (on: boolean) => (on ? followBoard(slug) : unfollowBoard(slug)),
    onSuccess: (state) => qc.setQueryData(qk.followBoard(slug), state),
  });
  const board = useQuery({
    queryKey: qk.board(slug),
    queryFn: ({ signal }) => fetchBoard(slug, signal),
    enabled: slug !== '',
    staleTime: 10 * 60_000,
  });
  const list = useInfiniteQuery({
    queryKey: qk.topics({ board: slug, kind: kind || undefined }),
    queryFn: ({ pageParam, signal }) =>
      fetchTopics({ board: slug, kind: kind || undefined, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    enabled: slug !== '',
    getNextPageParam: (last) => last.next,
  });

  const items: ApiTopic[] = list.data?.pages.flatMap((p) => p.items) ?? [];

  /** 改 URL 里的一个键；null 表示删掉它（默认值不进 URL，链接才短）——与首页同一个套路 */
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
    // 左栏与首页**同一份** BoardRail：点进分区后它不能消失 ——
    // 「我在哪个分区、还能去哪」是同一件事，换页就把它抽掉会让人找不到北（用户实测）。
    <div className='flex flex-col gap-6 xl:flex-row xl:items-start'>
      <BoardRail current={slug} className='hidden xl:flex xl:w-[168px] xl:shrink-0' />

      <div className='flex min-w-0 flex-1 flex-col gap-4'>
        <PageHeader
          title={board.data?.name ?? (board.isError ? '分区' : '正在加载分区…')}
          description={
            board.data ? (
              <span className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                <span>{board.data.description}</span>
                <span className='tabular-nums'>
                  {board.data.topic_count} 帖子
                  {board.data.today_count != null ? ' · 今日 ' + board.data.today_count : ''}
                  {/* 「关注数」这一格以前是假 0（后端 BoardDTO 没有 member_count，见进度-K-REL）：
                      现在它来自 GET /boards/{slug}/follow 的 follower_count（真数，现算不落列）。 */}
                  {follow.data ? ' · ' + follow.data.follower_count + ' 关注' : ''}
                </span>
              </span>
            ) : undefined
          }
          actions={
            <span className='flex items-center gap-2'>
              <Button
                data-testid='board-follow'
                inline={false}
                height={ControlsHeight.M}
                primary={!follow.data?.following}
                icon={icon16(follow.data?.following ? Star : UserPlus)}
                disabled={!session.isLoggedIn || follow.isPending || toggleFollow.isPending}
                loader={toggleFollow.isPending}
                onClick={() => toggleFollow.mutate(!follow.data?.following)}
              >
                {follow.data?.following ? '已关注' : '关注分区'}
              </Button>
              <ComposeButton board={slug} />
            </span>
          }
        />

        {/* 分区信息拿不到：就地说明 + 重试，不把下面的列表一起拖死 */}
        {board.isError ? (
          <ErrorState what='分区信息' error={board.error} onRetry={() => void board.refetch()} className='py-8' />
        ) : null}

        <div className='flex flex-wrap items-center justify-between gap-2 border-y border-border py-2'>
          <nav aria-label='帖子类型' className='flex flex-wrap items-center gap-2'>
            {KINDS.map((k) => (
              <Button
                key={k.key || 'all'}
                ghost={k.key !== kind}
                primary={k.key === kind}
                active={k.key === kind}
                height={ControlsHeight.S}
                onClick={() => setParam('kind', k.key || null)}
              >
                {k.label}
              </Button>
            ))}
          </nav>
          <span className='flex items-center gap-2'>
            {/* 视图与首页同一套写法（同一对图标、同一个 ?view= 键），两页之间来回切不会「换了个人做」 */}
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

        {list.isPending ? (
          <ul className={cn('m-0 list-none p-0', GRID.card)} aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <SquareCardSkeleton />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <ErrorState what='分区帖子' error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <Empty
            title={kind ? '这个类型下还没有帖子' : '这个分区还没有帖子'}
            hint={
              kind
                ? '换一个类型看看，或者用「全部」列出这个分区的所有帖子。'
                : '成为第一个在这里发帖的人：分区决定了这篇会出现在哪个列表里。'
            }
            action={
              <span className='flex flex-wrap items-center justify-center gap-2'>
                {kind ? <Button onClick={() => setParam('kind', null)}>看全部类型</Button> : null}
                <ComposeButton board={slug} />
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
                  <CompactTopicRow key={t.id} topic={toCardTopic(t)} href={appPath('t/' + encodeURIComponent(t.id))} />
                ))}
              </div>
            )}

            {list.hasNextPage ? (
              <div className='flex flex-col items-center gap-1.5'>
                <Button loader={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
                <span className='text-[11px] text-muted-foreground'>
                  每页 {PAGE_LIMIT} 条 · 按游标翻页（不是页码）
                </span>
              </div>
            ) : (
              <ListEnd total={items.length} />
            )}
          </>
        )}

        {/* 关注者（GET /boards/{slug}/followers，follow.UserItem 列表，公开读）：
            页头那格是关注**数**，这一格回答「是谁」。只取第一页，真数由页头那份 follow.State 给 ——
            列表被截断时就写「还有 N 人」，不编。 */}
        <section data-testid='board-followers' className='flex flex-col gap-2 border-t border-border pt-4'>
          <h2 className='m-0 text-[15px] font-semibold text-foreground'>关注者</h2>
          <UserFollowList
            queryKey={qk.boardFollowers(slug)}
            fetchPage={(signal) => fetchBoardFollowers(slug, {}, signal)}
            emptyTitle='还没有人关注这个分区'
            emptyHint='点页头那颗「关注分区」，你会是第一个。'
            total={follow.data?.follower_count ?? null}
          />
        </section>

        <Link
          to={routePath('')}
          className='inline-flex w-fit items-center gap-1 rounded-[3px] text-[12px] text-muted-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
        >
          <ArrowLeft aria-hidden className='size-3.5' />
          全部帖子
        </Link>
      </div>
    </div>
  );
}
