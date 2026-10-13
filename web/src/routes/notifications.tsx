import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Check, Inbox, Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { formatCents, formatTime } from '@/lib/format';
import {
  deleteNotification,
  fetchNotifications,
  fetchUnreadCount,
  markNotificationsRead,
  type Notification,
} from '@/lib/api/social';
import { UserAvatar } from '@/ui/user/avatar';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 通知中心（GET /notifications + /notifications/unread-count + POST /notifications/read + DELETE /notifications/:id）。
//
// 2026-10-13 接线时抓到的**契约错误**：这一页原先按 { summary, read } 渲染，而线上根本没有这两个字段 ——
// 后端给的是 payload / link / read_at / actor（notify/types.go 的 NotificationDTO 逐字）。
// 结果是「接口 200、列表有数据、每一行都是空白」：契约两侧各写一份，各自的测试都过。
//
// 所以这里**不造新形状**：动作文案由 kind 决定，正文取 payload.text，落点用后端给的 link。
// payload 里没有的（例如 reply 只带 ref_id）就不显示 —— 需要正文快照的话是后端的事，前端不假装有。

const KIND_ACTION: Record<string, string> = {
  reply: '回复了我',
  mention: '在回复里 @ 了我',
  like: '赞了我',
  reward: '给我打赏',
  review: '我的帖子有了审核结果',
  sanction: '我的账号被处罚',
  system: '发来一条系统通知',
};

// 取值与迁移 0004 的 ck_topics_review_state 逐字相同
const REVIEW_STATE: Record<string, string> = {
  pending: '仍在审核',
  approved: '已通过',
  rejected: '未通过',
};

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 这一条的正文（拿不到就不显示，不编）。 */
function detailOf(n: Notification): string | null {
  const p = n.payload ?? {};
  const body = text(p.text);
  if (n.kind === 'reward') {
    const cents = typeof p.amount_cents === 'number' ? p.amount_cents : null;
    return cents === null ? body : '金额 ¥' + formatCents(cents);
  }
  if (n.kind === 'review') {
    const state = text(p.state);
    return state ? '结果：' + (REVIEW_STATE[state] ?? state) + (body ? ' · ' + body : '') : body;
  }
  return body;
}

/** link 是站内路径（形如 "/t/<public_id>"）—— 必须去掉前导斜杠再交给 appPath，
 *  否则 new URL("/t/x", "/dev/") 会把它解析成站点根，跳出 /dev 前缀。 */
function linkOf(n: Notification): string | null {
  const l = (n.link ?? '').replace(/^\/+/, '');
  return l === '' ? null : appPath(l);
}

export function NotificationsPage() {
  const qc = useQueryClient();
  // 通知是**游标分页**的（后端多取一行判有没有下一页）：只画第一页会让老通知永远看不到。
  const list = useInfiniteQuery({
    queryKey: qk.notifications(),
    queryFn: ({ pageParam, signal }) => fetchNotifications({ cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const unread = useQuery({ queryKey: qk.unread(), queryFn: ({ signal }) => fetchUnreadCount(signal) });

  function refresh() {
    void qc.invalidateQueries({ queryKey: qk.notifications() });
    void qc.invalidateQueries({ queryKey: qk.unread() });
  }

  const markAll = useMutation({ mutationFn: () => markNotificationsRead({ all: true }), onSuccess: refresh });
  const markOne = useMutation({ mutationFn: (id: string) => markNotificationsRead({ ids: [id] }), onSuccess: refresh });
  const removeOne = useMutation({ mutationFn: (id: string) => deleteNotification(id), onSuccess: refresh });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadCount = unread.data?.count ?? 0;

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader
        title='通知中心'
        description={unread.isSuccess ? '未读 ' + unreadCount + ' 条' : '别人回复、点赞、@ 你时会出现在这里'}
        actions={
          <Button
            data-testid='notifications-read-all'
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Check)}
            disabled={unreadCount === 0 || markAll.isPending}
            loader={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            全部已读
          </Button>
        }
      />

      {list.isPending ? (
        <Loading what='通知' />
      ) : list.isError ? (
        <ErrorState what='通知' error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <Empty
          icon={Inbox}
          title='还没有通知'
          hint='被回复、被点赞、被 @ 时会在这里出现；读掉之后未读计数会归零。'
          action={<Button href={appPath('')}>回首页看看</Button>}
        />
      ) : (
        <ul className='m-0 flex list-none flex-col gap-0 rounded-lg border border-border bg-card p-0'>
          {items.map((n) => {
            const detail = detailOf(n);
            const href = linkOf(n);
            return (
              <li key={n.id} data-testid={'notification-' + n.id} className='flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0'>
                <UserAvatar name={n.actor?.nickname ?? '系统'} src={n.actor?.avatar} size='md' />
                <div className='flex min-w-0 flex-1 flex-col gap-1'>
                  <span className='flex flex-wrap items-baseline gap-2 text-[13px]'>
                    {n.actor ? <span className='font-semibold text-foreground'>{n.actor.nickname}</span> : null}
                    <span className={n.read_at ? 'text-muted-foreground' : 'font-medium text-foreground'}>
                      {KIND_ACTION[n.kind] ?? n.kind}
                    </span>
                    {n.read_at ? null : (
                      <span className='rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary'>未读</span>
                    )}
                  </span>
                  {detail ? <span className='text-[13px] leading-relaxed text-muted-foreground'>{detail}</span> : null}
                  <span className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground'>
                    <span className='tabular-nums'>{formatTime(n.created_at)}</span>
                    {href ? (
                      <a
                        href={href}
                        className='rounded-[3px] text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50'
                      >
                        查看
                      </a>
                    ) : null}
                    {n.read_at ? null : (
                      <Button
                        data-testid={'notification-read-' + n.id}
                        ghost
                        inline={false}
                        height={ControlsHeight.S}
                        disabled={markOne.isPending}
                        onClick={() => markOne.mutate(n.id)}
                      >
                        标为已读
                      </Button>
                    )}
                    <Button
                      data-testid={'notification-delete-' + n.id}
                      ghost
                      danger
                      inline={false}
                      height={ControlsHeight.S}
                      icon={icon16(Trash2)}
                      disabled={removeOne.isPending}
                      onClick={() => removeOne.mutate(n.id)}
                    >
                      删除
                    </Button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {list.hasNextPage ? (
        <div className='flex flex-col items-center gap-1.5'>
          <Button loader={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage ? '加载中…' : '加载更多'}
          </Button>
          <span className='text-[11px] text-muted-foreground'>每页 20 条 · 按游标翻页（不是页码）</span>
        </div>
      ) : null}
    </div>
  );
}
