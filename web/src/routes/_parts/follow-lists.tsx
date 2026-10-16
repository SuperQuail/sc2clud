import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { UserBadge } from '@/ui/user/user-badge';
import { routePath } from '@/lib/url';
import { formatTime } from '@/lib/format';
import type { FollowedBoard, FollowedUser } from '@/lib/api/follow';
import type { Paged } from '@/lib/api/forum';
import { imageUrl } from './mappers';
import { Empty, ErrorState, Loading } from './state';

// 「关注者 / 我关注的」三处**共用**的列表（L5 的第二批）：分区页的「关注者」、主页的「关注者」、
// 设置页的「我关注的」两档。行是同一份 follow.UserItem（只有分区那一条是 BoardItem），
// 所以三态（加载 / 空 / 错）与排版只写一份 —— 少一份就多一处「某一屏少了一个态」的白屏。
//
// 只取**第一页**（limit 20，游标分页）：这三格都是概览，不是能翻到底的独立列表。
// 「共多少人」让调用方从 follow.State.follower_count 传进来（那一条是后端现算的真数，不落列）——
// 列表被截断时说「还有 N 人」；拿不到真数（total=null）时**不编**一个数出来。

function Paged<T>({ queryKey, fetchPage, what, emptyTitle, emptyHint, children }: {
  queryKey: QueryKey;
  fetchPage: (signal?: AbortSignal) => Promise<Paged<T>>;
  what: string;
  emptyTitle: string;
  emptyHint?: string;
  children: (items: T[]) => ReactNode;
}) {
  const list = useQuery({ queryKey, queryFn: ({ signal }) => fetchPage(signal) });
  if (list.isPending) return <Loading what={what} className='py-6' />;
  if (list.isError) return <ErrorState what={what} error={list.error} onRetry={() => void list.refetch()} />;
  const items = list.data?.items ?? [];
  if (items.length === 0) return <Empty title={emptyTitle} hint={emptyHint} className='py-8' />;
  return <>{children(items)}</>;
}

const ROW = 'flex min-w-0 items-center gap-2 rounded-md px-2 py-1 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** 一行用户：头像 + 昵称 + @handle（整行链回 TA 的主页）。 */
function UserRow({ user }: { user: FollowedUser }) {
  return (
    <li className='min-w-0'>
      <Link to={routePath('u/' + encodeURIComponent(user.handle))} className={ROW}>
        <UserBadge
          user={{ handle: user.handle, nickname: user.nickname, avatar: imageUrl(user.avatar_hash) }}
          size='sm'
          showHandle
        />
        <span className='shrink-0 text-[11px] text-muted-foreground'>关注于 {formatTime(user.followed_at)}</span>
      </Link>
    </li>
  );
}

/** 用户清单（关注某分区的人 / 关注某人的人 / 我关注的人）。total = follower_count 那份真数，没有就给 null。 */
export function UserFollowList({ queryKey, fetchPage, emptyTitle, emptyHint, total = null }: {
  queryKey: QueryKey;
  fetchPage: (signal?: AbortSignal) => Promise<Paged<FollowedUser>>;
  emptyTitle: string;
  emptyHint?: string;
  total?: number | null;
}) {
  return (
    <Paged queryKey={queryKey} fetchPage={fetchPage} what='关注的人' emptyTitle={emptyTitle} emptyHint={emptyHint}>
      {(items) => {
        const rest = total === null ? 0 : Math.max(0, total - items.length);
        return (
          <ul className='m-0 flex list-none flex-wrap gap-1 p-0'>
            {items.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
            {rest > 0 ? (
              <li className='flex items-center px-2 text-[11px] text-muted-foreground'>…还有 {rest} 人</li>
            ) : null}
          </ul>
        );
      }}
    </Paged>
  );
}

/** 我关注的分区（设置页）：BoardItem 那一份形状，整行链回分区页。 */
export function BoardFollowList({ queryKey, fetchPage, emptyTitle, emptyHint }: {
  queryKey: QueryKey;
  fetchPage: (signal?: AbortSignal) => Promise<Paged<FollowedBoard>>;
  emptyTitle: string;
  emptyHint?: string;
}) {
  return (
    <Paged queryKey={queryKey} fetchPage={fetchPage} what='关注的分区' emptyTitle={emptyTitle} emptyHint={emptyHint}>
      {(items) => (
        <ul className='m-0 flex list-none flex-col gap-1 p-0'>
          {items.map((b) => (
            <li key={b.slug} className='min-w-0'>
              <Link to={routePath('b/' + encodeURIComponent(b.slug))} className={ROW}>
                <span className='min-w-0 shrink truncate text-[13px] font-medium text-foreground'>{b.name}</span>
                {b.description ? (
                  <span className='min-w-0 truncate text-[11px] text-muted-foreground'>{b.description}</span>
                ) : null}
                <span className='ml-auto shrink-0 text-[11px] text-muted-foreground'>关注于 {formatTime(b.followed_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Paged>
  );
}
