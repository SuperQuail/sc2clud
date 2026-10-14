import type { ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Check } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { routePath } from '@/lib/url';
import { formatTime } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { useLiveNotices } from '@/lib/query/live';
import { useSession } from '@/lib/perms';
import { deleteMessage, fetchConversations, fetchThread, fetchUnreadMessages, markThreadRead, sendMessage } from '@/lib/api/messages';
import {
  deleteNotification,
  fetchNoticeSettings,
  fetchNotifications,
  fetchUnreadCount,
  markNotificationsRead,
  muteNotificationKind,
  updateNoticeSettings,
} from '@/lib/api/social';
import { searchUsers } from '@/lib/api/user';
import { NoticeCenterView } from '@/devroom/pages/10-messages/notice-center-view';
import { resolveNoticeKind, type NoticeSources, type Panel } from '@/devroom/pages/10-messages/notice-logic';
import { PageHeader } from './_parts/layout';

// **信息中心**（DevRoom 10-messages 那一屏的产品宿主）。
//
// 版面一行都不在这里：全部在 `@/devroom/pages/10-messages/notice-center-view`（清单 §0 的同源要求
// —— 房间与真站渲染同一个 View，所以两个入口看同一页一致）。这个文件只做四件事：
//   ① 取数：把 lib/api 的函数按 NoticeSources 端口喂给 View；
//   ② 档位：URL 的 ?panel= / ?kind= 是**唯一真源**（D10 的修法），选中态与右栏都由它推；
//   ③ 页头：两档各一个（未读口径不同，别混着算）；
//   ④ 路由：`/messages` 默认「我的消息」档、`/notifications` 默认「回复我的」档。
//
// 字段名照后端抄（forum/internal/notify/types.go 的 NotificationDTO、
// forum/internal/message/types.go 的 Conversation/Message），不照设计稿 mock 抄。

/** 真端点的数据端口。只读的七个必给；写动作里 mutate 那部分在这一层（View 只调函数）。 */
const sources: NoticeSources = {
  conversations: async (cursor, signal) => {
    const p = await fetchConversations({ cursor }, signal);
    // DTO → 展示形状：摘要与时间在宿主里格式化（View 不认识 created_at 的格式）
    return {
      items: p.items.map((c) => ({
        peer: c.peer,
        messages: [],
        summary: c.last.body,
        lastAt: formatTime(c.last.created_at),
        unread: c.unread_count,
      })),
      next: p.next,
    };
  },
  thread: async (handle, signal) => {
    const t = await fetchThread(handle, {}, signal);
    return {
      peer: t.peer,
      next: t.next,
      // 后端按 id DESC 给（最新在前）；气泡要最早在上，所以翻一次。
      // 正文是纯文本（后端 body 是 varchar，没有 content_html）：按文本渲染，不当 HTML 用。
      items: t.items
        .slice()
        .reverse()
        .map((m) => ({
          id: m.id,
          from: m.mine ? ('me' as const) : ('other' as const),
          nickname: '',
          avatar: null,
          html: <span className='whitespace-pre-wrap'>{m.body}</span>,
          time: formatTime(m.created_at),
        })),
    };
  },
  unreadMessages: async (signal) => (await fetchUnreadMessages(signal)).count,
  notices: async (kind, cursor, signal) => {
    const p = await fetchNotifications({ kind, cursor }, signal);
    return { items: p.items, next: p.next };
  },
  unreadNotices: async (signal) => (await fetchUnreadCount(signal)).count,
  settings: (signal) => fetchNoticeSettings(signal),
  searchPeers: async (q, signal) => {
    // 用户档 q 必填（空词后端 400），View 已保证空词不发请求
    const found = await searchUsers(q, 20, signal);
    return found.map((u) => ({ handle: u.handle, nickname: u.nickname, avatar: u.avatar }));
  },
  saveSettings: (next) => updateNoticeSettings(next),
  sendMessage: (peer, body) => sendMessage(peer, body),
  retractMessage: (id) => deleteMessage(id),
  markThreadRead: (peer) => markThreadRead(peer),
  markNoticesRead: (body) => markNotificationsRead(body),
  deleteNotice: (id) => deleteNotification(id),
  muteKind: (kind) => muteNotificationKind(kind),
};

/** 导航键（'kind:reply' / 'messages' / 'settings'）→ 目标档。View 的回调只回 key，落 URL 在这一层。 */
function navTarget(key: string): { panel: Panel; kind: string | null } {
  if (key.startsWith('kind:')) return { panel: 'notices', kind: key.slice(5) };
  return { panel: key as Panel, kind: null };
}

function CenterShell({ panel: fallback, header }: { panel: Panel; header: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  // **档位只有一个真源：URL**（D10 的修法）。`panel` 这个 prop 只是「没带 ?panel= 时进哪一档」
  // 的默认值（/messages → messages、/notifications → notices）；一旦它进了状态，就会出现
  // 「地址栏说 settings、选中态还在 notices」——那正是 D10 报的现象。
  const panel: Panel = (params.get('panel') as Panel | null) ?? fallback;
  // 同理：?kind= 就是选中档 —— 可收藏、可刷新、可后退（原先靠组件内 state，回退就丢）
  const kind = resolveNoticeKind(params.get('kind') ?? 'reply');
  // 选中哪条会话由路由给（`/messages/:handle`）—— 不是组件内 state：刷新、分享链接、后退都停在同一个会话
  const handle = useParams().handle ?? null;

  /** 导航与分档都改 URL：react-router 会把 basename 前置到 `to` 上，所以这里用 setSearchParams */
  function go(next: { panel?: Panel; kind?: string | null }) {
    const p = new URLSearchParams(params);
    if (next.panel) {
      p.set('panel', next.panel);
      // 换档不留旧参数：?panel=settings&kind=like 会让「从哪一档来的」变成第二种真源
      if (next.panel !== 'notices') p.delete('kind');
    }
    if (next.kind) p.set('kind', next.kind);
    setParams(p, { replace: true });
  }

  /** 选中一条会话：把 :handle 写进地址栏（replace：切会话不该堆历史），然后标已读。 */
  function open(h: string) {
    navigate(routePath('messages/' + encodeURIComponent(h)), { replace: true });
    if (!session.isLoggedIn || h === '') return;
    void markThreadRead(h)
      .then(() => {
        void qc.invalidateQueries({ queryKey: qk.conversations() });
        void qc.invalidateQueries({ queryKey: qk.unreadMessages() });
      })
      .catch(() => {
        // 标已读失败不该把整页变成错误态：消息本身已经拿到了
      });
  }

  return (
    <NoticeCenterView
      panel={panel}
      kind={kind}
      peer={handle}
      onNav={(key) => go(navTarget(key))}
      onPeer={open}
      sources={sources}
      session={{
        isLoading: session.isLoading,
        loggedIn: session.isLoggedIn,
        nickname: session.session?.nickname ?? '我',
        avatar: session.session?.avatar,
      }}
      header={header}
    />
  );
}

/** 「我的消息」的页头：未读私信口径（通知那套未读在通知档里，不能混着算）。 */
function MessagesHeader() {
  const session = useSession();
  const unread = useQuery({
    queryKey: qk.unreadMessages(),
    queryFn: ({ signal }) => fetchUnreadMessages(signal),
    enabled: session.isLoggedIn,
  });
  const count = unread.data?.count ?? 0;
  return (
    <PageHeader
      title='我的消息'
      description={unread.isSuccess ? (count > 0 ? '未读 ' + count + ' 条私信' : '没有未读私信') : '一对一私信'}
    />
  );
}

/** 通知四档的页头：未读通知口径 + 「全部已读」。 */
function NoticesHeader() {
  const qc = useQueryClient();
  const live = useLiveNotices(true);
  const unread = useQuery({ queryKey: qk.unread(), queryFn: ({ signal }) => fetchUnreadCount(signal) });
  const markAll = useMutation({
    mutationFn: () => markNotificationsRead({ all: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notifications() });
      void qc.invalidateQueries({ queryKey: qk.unread() });
    },
  });
  const count = unread.data?.count ?? 0;
  return (
    <PageHeader
      title='通知中心'
      description={
        (unread.isSuccess ? (count > 0 ? '未读 ' + count + ' 条' : '没有未读通知') : '别人回复、点赞、@ 你时会出现在这里') +
        (live === 'live' ? ' · 实时' : ' · 每 30 秒刷新')
      }
      actions={
        <Button
          data-testid='notifications-read-all'
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(Check)}
          disabled={count === 0 || markAll.isPending}
          loader={markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          全部已读
        </Button>
      }
    />
  );
}

// 两条产品路由的入口：同一份 View，只是默认档不同（/messages 默认「我的消息」、
// /notifications 默认「回复我的」）。顶栏那两个入口（shell.tsx）因此都不用改，
// 而且从任何一页都能走到另一档。
export function MessagesPage() {
  return <CenterShell panel='messages' header={<MessagesHeader />} />;
}

/** 路由 `/notifications` 的入口：`routes/notifications.tsx` 只做一次转出（版面只有这一份）。 */
export function NotificationsPage() {
  return <CenterShell panel='notices' header={<NoticesHeader />} />;
}
