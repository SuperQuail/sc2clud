import { Link, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { fetchBoard, fetchTopics, type Topic as ApiTopic } from '@/lib/api/forum';
import { ArrowLeft } from 'lucide-react';
import { SquareTopicCard } from '@/devroom/pages/14-home/topic-square-card';
import { ListEnd, SquareCardSkeleton } from '@/devroom/pages/14-home/states';
import { ComposeButton, PageHeader } from './_parts/layout';
import { Empty, ErrorState } from './_parts/state';
import { toCardTopic } from './_parts/mappers';

// 分区页（契约：GET /boards/{slug} + GET /topics?board=<slug>）。
// 分区身份（封面 / 简介 / 统计）来自 board 详情，列表来自 topics；两块各自三态，
// 分区信息失败**不挡住列表** —— 「谁的信息没拿到」要说清楚，而不是整页白屏。
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
  const kind = params.get('kind') ?? '';
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

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader
        title={board.data?.name ?? (board.isError ? '分区' : '正在加载分区…')}
        description={
          board.data ? (
            <span className='flex flex-wrap items-center gap-x-3 gap-y-1'>
              <span>{board.data.description}</span>
              <span className='tabular-nums'>
                {board.data.topic_count} 帖子
                {board.data.today_count != null ? ' · 今日 ' + board.data.today_count : ''}
                {board.data.member_count != null ? ' · ' + board.data.member_count + ' 成员' : ''}
              </span>
            </span>
          ) : undefined
        }
        actions={<ComposeButton board={slug} />}
      />

      {/* 分区信息拿不到：就地说明 + 重试，不把下面的列表一起拖死 */}
      {board.isError ? (
        <ErrorState what='分区信息' error={board.error} onRetry={() => void board.refetch()} className='py-8' />
      ) : null}

      <nav aria-label='帖子类型' className='flex flex-wrap items-center gap-2 border-y border-border py-2'>
        {KINDS.map((k) => (
          <Button
            key={k.key || 'all'}
            ghost={k.key !== kind}
            primary={k.key === kind}
            active={k.key === kind}
            height={ControlsHeight.S}
            onClick={() =>
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (k.key) next.set('kind', k.key);
                  else next.delete('kind');
                  return next;
                },
                { replace: true },
              )
            }
          >
            {k.label}
          </Button>
        ))}
        <Link
          to={routePath('')}
          className='ml-auto inline-flex items-center gap-1 rounded-[3px] text-[12px] text-muted-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
        >
          <ArrowLeft aria-hidden className='size-3.5' />
          全部帖子
        </Link>
      </nav>

      {list.isPending ? (
        <ul className='m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' aria-busy>
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
          action={<ComposeButton board={slug} />}
        />
      ) : (
        <>
          <ul className='m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
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
          {list.hasNextPage ? (
            <div className='flex justify-center'>
              <Button loader={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? '加载中…' : '加载更多'}
              </Button>
            </div>
          ) : (
            <ListEnd total={items.length} />
          )}
        </>
      )}
    </div>
  );
}
