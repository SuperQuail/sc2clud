import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Send } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { formatTime } from '@/lib/format';
import { useSession } from '@/lib/perms';
import {
  fetchConversations,
  fetchThread,
  fetchUnreadMessages,
  markThreadRead,
  sendMessage,
} from '@/lib/api/messages';
import { CountBadge } from '@/ui/message/count-badge';
import { NoticeChat, type ChatMessage } from '@/ui/message/notice-chat';
import { UserAvatar } from '@/ui/user/avatar';
import { cn } from '@/lib/utils';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 私信（/messages 与 /messages/:handle 共用这一屏）。
//
// 2026-10-13：这一页原先是个占位页（「私信还没接后端」），而**六条端点在后端一直都在**
// （message.Handler.Register：列表 / 会话 / 发送 / 未读总数 / 标记已读 / 删除），前端连函数都没有。
// 所以这一版只做接线：形状照抄后端 message/types.go（peer / unread_count / last / mine / read）。
//
// 会话气泡复用 @/ui/message/notice-chat（10-messages 房间验证过的展示件），不新造控件。
// 正文是**纯文本**（后端 body 是 varchar，没有 content_html）：按文本渲染，不当 HTML 用。

export function MessagesPage() {
  const { handle } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();

  const [draft, setDraft] = useState('');
  const [peerInput, setPeerInput] = useState('');

  const loggedIn = session.isLoggedIn;
  // 会话列表是**游标分页**的：只画第一页会让老会话永远打不开。
  const conversations = useInfiniteQuery({
    queryKey: qk.conversations(),
    queryFn: ({ pageParam, signal }) => fetchConversations({ cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: loggedIn,
  });
  const unread = useQuery({ queryKey: qk.unreadMessages(), queryFn: ({ signal }) => fetchUnreadMessages(signal), enabled: loggedIn });
  const thread = useQuery({
    queryKey: qk.thread(handle ?? ''),
    queryFn: ({ signal }) => fetchThread(handle ?? '', {}, signal),
    enabled: loggedIn && Boolean(handle),
  });

  // 打开一个会话就把它标成已读：端点幂等（并发重放第二次返回 0），所以只按 handle 触发一次。
  useEffect(() => {
    if (!loggedIn || !handle) return;
    void markThreadRead(handle)
      .then(() => {
        void qc.invalidateQueries({ queryKey: qk.conversations() });
        void qc.invalidateQueries({ queryKey: qk.unreadMessages() });
      })
      .catch(() => {
        // 标已读失败不该把整页变成错误态：消息本身已经拿到了
      });
  }, [loggedIn, handle, qc]);

  const send = useMutation({
    mutationFn: (body: string) => sendMessage(handle ?? '', body),
    onSuccess: () => {
      setDraft('');
      void qc.invalidateQueries({ queryKey: qk.thread(handle ?? '') });
      void qc.invalidateQueries({ queryKey: qk.conversations() });
    },
  });

  if (session.isLoading) return <Loading what='账号信息' />;
  if (!loggedIn) {
    return (
      <div className='flex flex-col gap-4'>
        <PageHeader title='私信' description='登录后才能收发私信。' />
        <Empty
          title='先登录'
          hint='私信跟着账号走，游客看不到任何会话。'
          action={
            <Button inline={false} height={ControlsHeight.S} href={appPath('login?next=' + encodeURIComponent(routePath('messages')))}>
              去登录
            </Button>
          }
        />
      </div>
    );
  }

  // 后端按 id DESC 给（最新在前）；聊天气泡要最早在上，所以这里翻一次。
  const bubbles: ChatMessage[] = (thread.data?.items ?? [])
    .slice()
    .reverse()
    .map((m) => ({
      id: m.id,
      from: m.mine ? 'me' : 'other',
      nickname: m.mine ? (session.session?.nickname ?? '我') : (thread.data?.peer.nickname ?? handle ?? ''),
      avatar: m.mine ? session.session?.avatar : thread.data?.peer.avatar,
      html: <span className='whitespace-pre-wrap'>{m.body}</span>,
      time: formatTime(m.created_at),
    }));

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader
        title='私信'
        description={
          unread.data ? (unread.data.count > 0 ? '未读 ' + unread.data.count + ' 条' : '没有未读私信') : '一对一私信'
        }
      />

      <div className='grid gap-5 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]'>
        {/* 左栏：会话列表 + 开新会话。行是真链接（可新窗口打开、可分享）。 */}
        <section className='flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background'>
          <header className='flex items-center gap-2 border-b border-border px-3 py-2.5'>
            <h2 className='text-[15px] font-semibold text-foreground'>会话</h2>
            <CountBadge count={unread.data?.count ?? 0} />
          </header>

          <div className='flex min-h-0 flex-1 flex-col overflow-y-auto'>
            {conversations.isPending ? (
              <Loading what='会话' className='py-10' />
            ) : conversations.isError ? (
              <ErrorState what='会话' error={conversations.error} onRetry={() => void conversations.refetch()} />
            ) : (conversations.data?.pages.flatMap((p) => p.items).length ?? 0) === 0 ? (
              <div className='flex flex-col items-center gap-2 px-4 py-10 text-center'>
                <span className='text-[15px] text-foreground'>还没有会话</span>
                <span className='text-[12px] text-muted-foreground'>在下面按对方的 @handle 发起第一条私信</span>
              </div>
            ) : (
              conversations.data?.pages.flatMap((p) => p.items).map((c) => {
                const selected = c.peer.handle === handle;
                return (
                  <Link
                    key={c.peer.handle}
                    data-testid={'conversation-' + c.peer.handle}
                    to={routePath('messages/' + encodeURIComponent(c.peer.handle))}
                    aria-current={selected ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 border-b border-border border-l-[3px] border-l-transparent px-3 py-2.5 outline-none transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      selected && 'border-l-primary bg-primary/8',
                    )}
                  >
                    <UserAvatar name={c.peer.nickname} src={c.peer.avatar} size='md' />
                    <span className='flex min-w-0 flex-1 flex-col'>
                      <span className='truncate text-[13px] font-medium text-foreground'>{c.peer.nickname}</span>
                      <span className='truncate text-[12px] text-muted-foreground'>{c.last.body}</span>
                    </span>
                    <span className='flex shrink-0 flex-col items-end gap-1'>
                      <span className='text-[11px] tabular-nums text-muted-foreground'>{formatTime(c.last.created_at)}</span>
                      <CountBadge count={c.unread_count} />
                    </span>
                  </Link>
                );
              })
            )}

            {conversations.hasNextPage ? (
              <div className='flex justify-center p-2'>
                <Button
                  loader={conversations.isFetchingNextPage}
                  inline={false}
                  height={ControlsHeight.S}
                  onClick={() => void conversations.fetchNextPage()}
                >
                  {conversations.isFetchingNextPage ? '加载中…' : '更早的会话'}
                </Button>
              </div>
            ) : null}
          </div>

          {/* 开新会话：会话列表里没有的人只能靠 handle 找到 —— 后端 GET /messages/{handle}
              对「从没聊过但存在的人」返回空列表 + peer，所以这里只需要把人送过去。 */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const h = peerInput.trim().replace(/^@/, '');
              if (h === '') return;
              setPeerInput('');
              navigate(routePath('messages/' + encodeURIComponent(h)));
            }}
            className='flex items-end gap-2 border-t border-border p-3'
          >
            <span className='min-w-0 flex-1'>
              <Input
                value={peerInput}
                onChange={(e) => setPeerInput(e.target.value)}
                label='新会话'
                placeholder='对方的 @handle'
              />
            </span>
            <Button type='submit' inline={false} height={ControlsHeight.M} disabled={peerInput.trim() === ''}>
              开始
            </Button>
          </form>
        </section>

        {/* 右栏：会话内容。没有选中会话时给一句话 + 一条出路，不白屏。 */}
        {!handle ? (
          <Empty
            icon={Send}
            title='选一个会话开始'
            hint='左边点一个已有会话，或者用底部的「新会话」按对方的 @handle 开一条。'
          />
        ) : thread.isPending ? (
          <Loading what='消息' />
        ) : thread.isError ? (
          <ErrorState what='消息' error={thread.error} onRetry={() => void thread.refetch()} />
        ) : (
          <NoticeChat
            messages={bubbles}
            title={
              <span className='flex items-center gap-2'>
                <UserAvatar name={thread.data?.peer.nickname ?? handle} src={thread.data?.peer.avatar} size='sm' />
                {thread.data?.peer.nickname ?? handle}
                <a className='text-[12px] font-normal text-primary hover:underline' href={appPath('u/' + encodeURIComponent(handle))}>
                  @{handle}
                </a>
              </span>
            }
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const body = draft.trim();
                if (body === '') return;
                send.mutate(body);
              }}
              className='flex flex-col gap-2 border-t border-border p-4'
            >
              <Input
                multiline
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                label='写私信'
                placeholder='内容会原样发给对方（纯文本）'
              />
              <span className='flex items-center justify-between gap-2'>
                <span className='text-[11px] text-muted-foreground'>Enter 换行，写完点「发送」</span>
                <Button
                  data-testid='dm-send'
                  type='submit'
                  primary
                  inline={false}
                  icon={icon16(Send)}
                  disabled={draft.trim() === '' || send.isPending}
                  loader={send.isPending}
                >
                  发送
                </Button>
              </span>
            </form>
          </NoticeChat>
        )}
      </div>
    </div>
  );
}
