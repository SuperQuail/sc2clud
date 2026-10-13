import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import { fetchUnreadCount, fetchNotifications } from '@/lib/api/social';
import { appPath } from '@/lib/url';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Inbox, MessageSquare, Search as SearchIcon, Download } from 'lucide-react';

// 尚未接线的产品路由（/search、/notifications、/messages、/download）。
//
// **为什么要有这一页而不是删掉路由**：这些入口已经出现在顶栏、个人主页、帖子里（点下去就是 404 或白屏），
// 而契约 §21.2 里它们的端点都已经定了。所以这一版给它们一个**说清现状**的落地页：
// 能接的先接（通知中心有 GET /notifications），剩下的明说「还没接」+ 建单。
//
// 判据（开发必读：不实文案不如实话）：**能拿到数据的就真渲染，拿不到的说清还差什么**。

export function NotificationsPage() {
  const list = useQuery({ queryKey: qk.unread(), queryFn: ({ signal }) => fetchNotifications({}, signal) });
  const unread = useQuery({ queryKey: [...qk.unread(), 'count'], queryFn: ({ signal }) => fetchUnreadCount(signal) });
  return (
    <div className='flex flex-col gap-4'>
      <PageHeader
        title='通知中心'
        description={unread.data ? '未读 ' + unread.data.count + ' 条' : '别人回复、点赞、@ 你时会出现在这里'}
      />
      {list.isPending ? (
        <Loading what='通知' />
      ) : list.isError ? (
        <ErrorState what='通知' error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <Empty
          icon={Inbox}
          title='还没有通知'
          hint='被回复、被点赞、被 @ 时会在这里出现；读掉之后角标会消失。'
          action={<Button href={appPath('')}>回首页看看</Button>}
        />
      ) : (
        <ul className='m-0 flex list-none flex-col gap-2 p-0'>
          {list.data.items.map((n) => (
            <li key={n.id} className='rounded-lg border border-border bg-card px-3 py-2 text-[13px]'>
              <span className='text-foreground'>{n.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 还没有端点的三个页面共用这一屏：**不许白屏**，也不许装作能用。 */
export function PendingPage({ what, icon = MessageSquare, endpoints }: { what: string; icon?: typeof MessageSquare; endpoints: string[] }) {
  return (
    <div className='flex flex-col gap-4'>
      <PageHeader title={what} description='页面已经挂在真实路由上，接口还没接。' />
      <Empty
        icon={icon}
        title={what + '还没接后端'}
        hint={
          <span className='flex flex-col gap-1'>
            <span>契约里已经有端点，接上就能用：</span>
            {endpoints.map((e) => (
              <code key={e} className='rounded-sm bg-muted px-1 text-[12px]'>
                {e}
              </code>
            ))}
          </span>
        }
        action={<Button href={appPath('')}>回首页</Button>}
      />
    </div>
  );
}

export function SearchPage() {
  return <PendingPage what='搜索' icon={SearchIcon} endpoints={['GET /api/v1/search?q=&type=topics|users']} />;
}

export function MessagesPage() {
  return (
    <PendingPage
      what='私信'
      endpoints={['GET /api/v1/messages', 'GET /api/v1/messages/{handle}', 'POST /api/v1/messages/{handle}']}
    />
  );
}

export function DownloadPage() {
  return (
    <PendingPage
      what='启动器下载'
      icon={Download}
      endpoints={['GET /api/v1/launcher/latest', 'GET /api/v1/launcher/releases', 'GET /api/v1/launcher/assets/{id}/go']}
    />
  );
}
