import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { CalendarDays, Heart, MessageSquare, Star } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserBadge } from '@/ui/user/user-badge';
import { TopicRow } from '@/ui/topic/topic-row';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { can, useSession } from '@/lib/perms';
import { fetchUserProfile, fetchUserTopics } from '@/lib/api/user';
import { formatTime } from '@/lib/format';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 个人主页（契约：GET /users/{handle} 聚合 + GET /users/{handle}/topics 游标分页）。
// 「本人 / 别人」由**接口的 is_self** 决定，不由前端猜（11-profile 那次缺陷的根因就是判对象真值）。
// 只有接口真的给了的能力才画出来：头衔目录、回复列表、收藏、赞过、打赏统计都还没有端点，
// 所以这一版只有「帖子」一个标签页，其余记进回报的端点清单 —— 不做点了没反应的入口。
export function ProfilePage() {
  const { handle = '' } = useParams();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'topics' ? 'topics' : 'overview';

  const profile = useQuery({
    queryKey: qk.profile(handle),
    queryFn: ({ signal }) => fetchUserProfile(handle, signal),
    enabled: handle !== '',
    staleTime: 60_000,
  });
  const topics = useQuery({
    queryKey: qk.userTopics(handle),
    queryFn: ({ signal }) => fetchUserTopics(handle, {}, signal),
    enabled: handle !== '' && tab === 'topics',
  });

  if (profile.isPending) return <Loading what='个人主页' />;
  if (profile.isError) {
    return <ErrorState what='个人主页' error={profile.error} onRetry={() => void profile.refetch()} />;
  }

  const u = profile.data;
  const isSelf = u.is_self === true || (session.session?.handle != null && session.session.handle === u.handle);
  const stats = u.stats;

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader
        title={u.nickname}
        description={
          <span className='flex flex-wrap items-center gap-x-3 gap-y-1'>
            <span>@{u.handle}</span>
            {u.joined_at ? (
              <span className='flex items-center gap-1'>
                <CalendarDays aria-hidden className='size-3.5' />
                {u.joined_at} 加入
              </span>
            ) : null}
          </span>
        }
        actions={
          <span className='flex flex-wrap items-center gap-2'>
            {u.handle === session.session?.handle ? null : (
              <Button inline={false} height={ControlsHeight.M} disabled title='关注功能还没有端点（见回报的端点清单）'>
                关注
              </Button>
            )}
            <Button inline={false} height={ControlsHeight.M} icon={icon16(MessageSquare)} href={appPath('messages/' + encodeURIComponent(u.handle))}>
              发私信
            </Button>
          </span>
        }
      />

      <section className='flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-card p-4'>
        <UserBadge user={u} layout='stacked' size='xl' showHandle badges='below' />
        <div className='flex flex-col gap-2'>
          {u.bio ? <p className='m-0 max-w-[60ch] text-[13px] leading-relaxed text-muted-foreground'>{u.bio}</p> : null}
          <dl className='m-0 flex flex-wrap items-center gap-6'>
            <Stat icon={<Star aria-hidden className='size-3' />} label='帖子' value={stats?.topic_count} />
            <Stat icon={<MessageSquare aria-hidden className='size-3' />} label='回复' value={stats?.reply_count} />
            <Stat icon={<Heart aria-hidden className='size-3' />} label='获赞' value={stats?.like_received} />
          </dl>
        </div>
        {isSelf ? (
          <Button inline={false} height={ControlsHeight.S} href={appPath('settings')}>
            账号设置
          </Button>
        ) : null}
      </section>

      <ButtonSet className='border-b border-border pb-2'>
        {[
          { key: 'overview', label: '概览' },
          { key: 'topics', label: '帖子' },
        ].map((t) => (
          <Button
            key={t.key}
            primary={t.key === tab}
            ghost={t.key !== tab}
            active={t.key === tab}
            height={ControlsHeight.S}
            onClick={() =>
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (t.key === 'overview') next.delete('tab');
                  else next.set('tab', t.key);
                  return next;
                },
                { replace: true },
              )
            }
          >
            {t.label}
          </Button>
        ))}
      </ButtonSet>

      {tab === 'overview' ? (
        <section className='flex flex-col gap-2'>
          <h2 className='m-0 text-[15px] font-semibold text-foreground'>最近发布</h2>
          {topics.isPending ? (
            <Loading what='帖子' className='py-8' />
          ) : topics.isError ? (
            <ErrorState what='帖子' error={topics.error} onRetry={() => void topics.refetch()} />
          ) : (topics.data?.items.length ?? 0) === 0 ? (
            <Empty title='还没有发布过帖子' hint='发过的帖子会按时间倒序列在这里。' />
          ) : (
            <div className='rounded-lg border border-border bg-card'>
              {topics.data?.items.slice(0, 5).map((t) => (
                <TopicRow
                  key={t.id}
                  topic={{
                    id: t.id,
                    title: t.title,
                    tags: [{ text: t.board.name }],
                    author: t.author,
                    replies: t.reply_count,
                    views: t.view_count,
                    lastReplyAt: formatTime(t.last_reply_at ?? t.created_at),
                    href: appPath('t/' + encodeURIComponent(t.id)),
                  }}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'topics' ? (
        <section className='flex flex-col gap-2'>
          {topics.isPending ? (
            <Loading what='帖子' className='py-8' />
          ) : topics.isError ? (
            <ErrorState what='帖子' error={topics.error} onRetry={() => void topics.refetch()} />
          ) : (topics.data?.items.length ?? 0) === 0 ? (
            <Empty
              title={isSelf ? '你还没有发布过帖子' : 'TA 还没有发布过帖子'}
              hint='帖子按发布时间倒序；游标分页，不是页码。'
            />
          ) : (
            <div className='rounded-lg border border-border bg-card'>
              {topics.data?.items.map((t) => (
                <TopicRow
                  key={t.id}
                  topic={{
                    id: t.id,
                    title: t.title,
                    tags: [{ text: t.board.name }],
                    author: t.author,
                    replies: t.reply_count,
                    views: t.view_count,
                    lastReplyAt: formatTime(t.last_reply_at ?? t.created_at),
                    href: appPath('t/' + encodeURIComponent(t.id)),
                  }}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {isSelf && !can(session.session, 'post.create') ? (
        <p className='m-0 rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground'>
          你的账号现在不能发帖（未激活或没有 post.create 权限）。账号状态在{' '}
          <Link to={appPath('settings')} className='underline'>
            账号设置
          </Link>
          。
        </p>
      ) : null}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value?: number }) {
  return (
    <div className='flex flex-col'>
      <dt className='order-2 flex items-center gap-1 text-[11px] text-muted-foreground'>
        {icon}
        {label}
      </dt>
      <dd className='order-1 text-[16px] font-semibold tabular-nums text-foreground'>{value ?? '—'}</dd>
    </div>
  );
}
