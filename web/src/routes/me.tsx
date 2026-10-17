import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { appPath, routePath } from '@/lib/url';
import { useSession } from '@/lib/perms';
import { formatTime } from '@/lib/format';
import { TopicRow } from '@/ui/topic/topic-row';
import { fetchMyBookmarks, fetchMyReports } from '@/lib/api/forum';
import { REASON_LABEL } from './_parts/report-panel';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 「我的」页：收藏 + 举报进展。
//
// 盲测（2026-10-13）：「我的收藏」「我的举报」在界面上**根本不存在** —— 接口 `GET /me/bookmarks`、
// `GET /me/reports` 一直在，前端连函数都没有，所以用户「收藏了找不回来、举报了不知道下文」。
// 两个标签共用一个页面：它们都是「我做过的事」，拆成两个路由只会多两处导航。
const TABS = [
  { key: 'bookmarks', label: '我的收藏' },
  { key: 'reports', label: '我的举报' },
] as const;

const STATE_LABEL: Record<string, string> = {
  open: '待处理',
  handled: '已处理',
  dismissed: '已驳回',
};

export function MePage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'reports' ? 'reports' : 'bookmarks';

  // 只在当前标签发请求：另一个标签的数据没必要拉。
  const bookmarks = useQuery({
    queryKey: ['me', 'bookmarks'],
    queryFn: ({ signal }) => fetchMyBookmarks({}, signal),
    enabled: session.isLoggedIn && tab === 'bookmarks',
    staleTime: 30_000,
  });
  const reports = useQuery({
    queryKey: ['me', 'reports'],
    queryFn: ({ signal }) => fetchMyReports({}, signal),
    enabled: session.isLoggedIn && tab === 'reports',
    staleTime: 30_000,
  });

  if (session.isLoading) return <Loading what='账号信息' />;
  if (!session.isLoggedIn) {
    return (
      <div className='flex flex-col gap-4'>
        <PageHeader title='我的' description='登录后才能看自己的收藏与举报。' />
        <Empty
          title='先登录'
          hint='收藏与举报都跟着账号走。'
          action={<Button inline={false} height={ControlsHeight.S} href={appPath('login?next=' + encodeURIComponent(routePath('me')))}>去登录</Button>}
        />
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader title='我的' description='收藏过的帖子、发出过的举报与它们的处理进展。' />

      <span className='flex flex-wrap items-center gap-2'>
        {TABS.map((t) => (
          <Button
            key={t.key}
            data-testid={'me-tab-' + t.key}
            ghost
            inline={false}
            height={ControlsHeight.S}
            active={tab === t.key}
            onClick={() => setParams({ tab: t.key })}
          >
            {t.label}
          </Button>
        ))}
      </span>

      {tab === 'bookmarks' ? (
        bookmarks.isPending ? (
          <Loading what='收藏' />
        ) : bookmarks.isError ? (
          <ErrorState what='收藏' error={bookmarks.error} onRetry={() => void bookmarks.refetch()} />
        ) : (bookmarks.data?.items.length ?? 0) === 0 ? (
          <Empty title='还没有收藏' hint='在帖子页点「收藏」，它会出现在这里。' />
        ) : (
          <ul className='m-0 flex list-none flex-col gap-0 rounded-lg border border-border bg-card p-0'>
            {bookmarks.data?.items.map((t) => (
              <li key={t.id}>
                <TopicRow topic={{ ...t, href: appPath('t/' + encodeURIComponent(t.id)) }} />
              </li>
            ))}
          </ul>
        )
      ) : reports.isPending ? (
        <Loading what='举报' />
      ) : reports.isError ? (
        <ErrorState what='举报' error={reports.error} onRetry={() => void reports.refetch()} />
      ) : (reports.data?.items.length ?? 0) === 0 ? (
        <Empty title='还没有举报' hint='在帖子或回复上点「举报」，处理进展会出现在这里。' />
      ) : (
        <ul className='m-0 flex list-none flex-col gap-2 p-0'>
          {reports.data?.items.map((r) => (
            <li key={r.id} className='flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3'>
              <span className='flex flex-wrap items-center gap-2'>
                <span className='text-[14px] font-medium text-foreground'>{r.target_label}</span>
                <span className='rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground'>
                  {STATE_LABEL[r.state] ?? r.state}
                </span>
              </span>
              <span className='text-[12px] text-muted-foreground'>
                事由：{REASON_LABEL[r.reason] ?? r.reason} · {formatTime(r.created_at)}
                {r.handle_note ? ' · 管理员说明：' + r.handle_note : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}