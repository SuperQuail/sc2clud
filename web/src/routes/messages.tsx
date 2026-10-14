import { useDeferredValue, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { AtSign, Bell, Check, Inbox, MessageSquare, Send, Settings, ThumbsUp, Trash2, UserRound, type LucideIcon } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { formatCents, formatTime } from '@/lib/format';
import { useSession } from '@/lib/perms';
import {
  fetchConversations,
  fetchThread,
  fetchUnreadMessages,
  markThreadRead,
  sendMessage,
} from '@/lib/api/messages';
import {
  deleteNotification,
  fetchNoticeSettings,
  fetchNotifications,
  fetchUnreadCount,
  markNotificationsRead,
  updateNoticeSettings,
  type Notification,
  type NoticeSettings as NoticeSettingsDTO,
} from '@/lib/api/social';
import { PageHeader } from './_parts/layout';
import { searchUsers } from '@/lib/api/user';
import { NoticeLayout } from '@/ui/message/notice-layout';
import { NoticeList } from '@/ui/message/notice-list';
import { NoticeNav, type NoticeNavItem } from '@/ui/message/notice-nav';
import { NoticeRow } from '@/ui/message/notice-row';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { UserAvatar } from '@/ui/user/avatar';
import { MessagesPanel, plainText } from '@/devroom/pages/10-messages/messages-panel';
import { PeerPicker } from '@/devroom/pages/10-messages/peer-picker';
import type { Conversation, Peer } from '@/devroom/pages/10-messages/types';
import { Empty, ErrorState, Loading } from './_parts/state';

// **信息中心**（DevRoom 10-messages 那一屏的产品版，2026-10-14 重建）。
//
// 这一版把原先「两个各写一套的页」收成一份：\`/messages\`（默认「我的消息」档）与
// \`/notifications\`（默认「回复我的」档）**渲染同一个 NoticeCenter**，只是入口档不同 ——
// 而 NoticeCenter 的左边导航同时通向两档，所以从哪一页进去都能走遍全站的消息。
//
// 版面全部是 DevRoom 里那些件：\`NoticeLayout\` + \`NoticeNav\`（壳）、\`NoticeList\` + \`NoticeRow\`（四档通知）、
// \`MessagesPanel\`（私信两栏，已改成 prop 驱动）、\`PeerPicker\`（选人）、\`NoticeSettings\`（消息设置）、
// \`CountBadge\`（未读角标）。**这一页没有一个手写控件**（原先的会话行是 \`<Link>\` 拼的、输入区是手写 \`<form>\`）。
//
// 字段名照后端抄（\`forum/internal/notify/types.go\` 的 NotificationDTO 与
// \`forum/internal/message/types.go\` 的 Conversation / Message），不照设计稿 mock。

// 三档面板（两档通知按 kind 再分四小档）。
type Panel = 'notices' | 'messages' | 'settings';

/** 通知分档 → 后端 \`?kind=\` 的单值（notify/kinds.go 的值域逐字）。 */
const NOTICE_KINDS: Array<{ kinds: string[]; label: string; icon: LucideIcon }> = [
  { kinds: ['reply'], label: '回复我的', icon: Send },
  { kinds: ['mention'], label: '@ 我的', icon: AtSign },
  { kinds: ['like'], label: '收到的赞', icon: ThumbsUp },
  { kinds: ['system', 'review', 'sanction', 'reward'], label: '系统通知', icon: Bell },
];

const KIND_SEP = ',';
/** URL 的 ?kind= 与档位之间的归一：四类合一的档在 URL 上是一串，旧书签的单值（?kind=review）也要落到它那一档。 */
function resolveNoticeKind(raw: string): string {
  const one = NOTICE_KINDS.find((t) => t.kinds.join(KIND_SEP) === raw || t.kinds.includes(raw));
  return (one ?? NOTICE_KINDS[0]!).kinds.join(KIND_SEP);
}

export function NoticeCenter({ panel }: { panel: Panel }) {
  const [params, setParams] = useSearchParams();
  // 档位：URL 的 \`?kind=\` **就是**选中档 —— 可收藏、可刷新、可后退（原先靠组件内 state，回退就丢）。
  const kind = resolveNoticeKind(params.get('kind') ?? 'reply');

  /** 导航与分档都改 URL：react-router 会把 basename 前置到 \`to\` 上，所以这里用 setSearchParams */
  function go(next: { panel?: Panel; kind?: string }) {
    const p = new URLSearchParams(params);
    if (next.panel) {
      p.set('panel', next.panel);
      if (next.panel !== 'notices') p.delete('kind');
    }
    if (next.kind) p.set('kind', next.kind);
    setParams(p, { replace: true });
  }

  // 通知那四档的 key 带 `kind:` 前缀：否则「回复我的」这一档的 key 会跟别的项撞上，
  // 而 NoticeNav 只认识一个 value 字符串（它是通用件，不该知道「消息中心」有几种命名空间）。
  const nav: NoticeNavItem[] = [
    { key: 'messages', label: '我的消息', icon: <MessageSquare aria-hidden className='size-4' /> },
    ...NOTICE_KINDS.map((k) => ({ key: 'kind:' + k.kinds.join(KIND_SEP), label: k.label, icon: <k.icon aria-hidden className='size-4' /> })),
    { key: 'settings', label: '消息设置', icon: <Settings aria-hidden className='size-4' />, groupTitle: '设置' },
  ];

  const value = panel === 'messages' ? 'messages' : panel === 'settings' ? 'settings' : 'kind:' + kind;

  return (
    <NoticeLayout
      nav={
        <NoticeNav
          items={nav}
          value={value}
          onChange={(key) => (key.startsWith('kind:') ? go({ panel: 'notices', kind: key.slice(5) }) : go({ panel: key as Panel }))}
          title='消息中心'
          titleIcon={<Send aria-hidden className='size-4' />}
        />
      }
    >
      {panel === 'messages' ? <MessagesPane /> : null}
      {panel === 'notices' ? <NoticesPane kind={kind} /> : null}
      {panel === 'settings' ? <SettingsPane /> : null}
    </NoticeLayout>
  );
}

// ── 我的消息（私信）─────────────────────────────────────────────
//
// 数据源：\`GET /messages\`（会话列表，游标分页）、\`GET /messages/{handle}\`（会话，倒序）、
// \`POST /messages/{handle}\`（发送）、\`POST /messages/{handle}/read\`（打开即已读）。
// 选中哪条会话由 URL 决定（\`/messages/:handle\`）—— 分享一条私信地址能直接落到那个会话。

function MessagesPane() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  // 选中哪条会话由路由给（\`/messages/:handle\`）—— 不是组件内 state：刷新、分享链接、后退都停在同一个会话
  const handle = useParams().handle ?? null;
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState('');
  const deferred = useDeferredValue(keyword.trim());
  const loggedIn = session.isLoggedIn;

  const conversations = useInfiniteQuery({
    queryKey: qk.conversations(),
    queryFn: ({ pageParam, signal }) => fetchConversations({ cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: loggedIn,
  });
  const thread = useQuery({
    queryKey: qk.thread(handle ?? ''),
    queryFn: ({ signal }) => fetchThread(handle ?? '', {}, signal),
    enabled: loggedIn && Boolean(handle),
  });
  // 选人弹层的目录：GET /search?type=users（q 为空时后端 400，所以这个词为空就不发）
  const found = useQuery({
    queryKey: qk.search('users', deferred),
    queryFn: ({ signal }) => searchUsers(deferred, 20, signal),
    enabled: picking && deferred !== '',
  });

  const rows = conversations.data?.pages.flatMap((p) => p.items) ?? [];
  // 后端给的是 DTO（peer / unread_count / last），MessagesPanel 要的是展示形状（summary / lastAt / unread）
  const list: Conversation[] = rows.map((c) => ({
    peer: c.peer,
    messages: [],
    summary: c.last.body,
    lastAt: formatTime(c.last.created_at),
    unread: c.unread_count,
  }));
  // 只是「跟没聊过的人开的会话」：不在列表里也要能进（GET /messages/{handle} 对这种人返回空列表 + peer）
  if (handle && !rows.some((c) => c.peer.handle === handle) && thread.data) {
    list.unshift({ peer: thread.data.peer, messages: [], summary: '', lastAt: '', unread: 0 });
  }
  // 后端按 id DESC 给（最新在前）；聊天气泡要最早在上，所以翻一次
  const bubbles = (thread.data?.items ?? [])
    .slice()
    .reverse()
    .map((m) => ({
      id: m.id,
      from: (m.mine ? 'me' : 'other') as 'me' | 'other',
      nickname: m.mine ? (session.session?.nickname ?? '我') : (thread.data?.peer.nickname ?? handle ?? ''),
      avatar: m.mine ? session.session?.avatar : thread.data?.peer.avatar,
      // 正文是纯文本（后端 body 是 varchar，没有 content_html）：按文本渲染，不当 HTML 用
      html: <span className='whitespace-pre-wrap'>{m.body}</span>,
      time: formatTime(m.created_at),
    }));

  const send = useMutation({
    mutationFn: (body: string) => sendMessage(handle ?? '', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.thread(handle ?? '') });
      void qc.invalidateQueries({ queryKey: qk.conversations() });
    },
  });

  /** 选中一条会话：把 \`:handle\` 写进地址栏（\`replace\`：切会话不该堆历史），然后标已读。 */
  function open(h: string) {
    navigate(routePath('messages/' + encodeURIComponent(h)), { replace: true });
    if (!loggedIn || h === '') return;
    void markThreadRead(h)
      .then(() => {
        void qc.invalidateQueries({ queryKey: qk.conversations() });
        void qc.invalidateQueries({ queryKey: qk.unreadMessages() });
      })
      .catch(() => {
        // 标已读失败不该把整页变成错误态：消息本身已经拿到了
      });
  }

  if (session.isLoading) return <Loading what='账号信息' />;
  if (!loggedIn) {
    return (
      <Empty
        title='先登录'
        hint='私信跟着账号走，游客看不到任何会话。'
        action={
          <Button inline={false} height={ControlsHeight.S} href={appPath('login?next=' + encodeURIComponent(routePath('messages')))}>
            去登录
          </Button>
        }
      />
    );
  }

  const peers: Peer[] = (found.data ?? []).map((u) => ({ handle: u.handle, nickname: u.nickname, avatar: u.avatar }));

  return (
    <>
      <MessagesPanel
        conversations={list}
        selectedHandle={handle}
        messages={bubbles}
        onSelect={open}
        onSend={(payload) => {
          const body = plainText(payload.html).replace(/\n/g, ' ').trim();
          if (body !== '') send.mutate(body);
        }}
        busy={send.isPending}
        onOpenPicker={() => setPicking(true)}
        placeholder={bubbles.length === 0 ? '还没有消息，先打个招呼吧' : undefined}
        picker={() =>
          picking ? (
            <PeerPicker
              people={peers}
              existing={rows.map((c) => c.peer.handle)}
              busy={found.isFetching}
              onSearch={setKeyword}
              onPick={(p) => {
                setPicking(false);
                open(p.handle);
              }}
              onClose={() => {
                setPicking(false);
                setKeyword('');
              }}
            />
          ) : null
        }
        headerActions={
          thread.data ? (
            <span className='flex items-center gap-2'>
              <a
                href={appPath('u/' + encodeURIComponent(thread.data.peer.handle))}
                className='flex items-center gap-2 rounded-[3px] px-1 py-0.5 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50'
                title={'查看 ' + thread.data.peer.nickname + ' 的主页'}
              >
                <UserAvatar name={thread.data.peer.nickname} src={thread.data.peer.avatar} size='sm' />
                <span className='text-[13px] text-muted-foreground'>@{thread.data.peer.handle}</span>
              </a>
            </span>
          ) : null
        }
        listFooter={
          conversations.hasNextPage ? (
            <Button
              loader={conversations.isFetchingNextPage}
              inline={false}
              height={ControlsHeight.S}
              onClick={() => void conversations.fetchNextPage()}
            >
              {conversations.isFetchingNextPage ? '加载中…' : '更早的会话'}
            </Button>
          ) : null
        }
        empty={
          !handle ? (
            conversations.isError ? (
              <ErrorState what='会话' error={conversations.error} onRetry={() => void conversations.refetch()} />
            ) : (
              <Empty
                icon={Send}
                title='选一个会话开始'
                hint='左边点一个已有会话，或用「选择聊天对象」搜一个人开新的私信。'
              />
            )
          ) : thread.isPending ? (
            <Loading what='消息' />
          ) : thread.isError ? (
            <ErrorState what='消息' error={thread.error} onRetry={() => void thread.refetch()} />
          ) : null
        }
      />

      <p className='m-0 text-[12px] text-muted-foreground'>
        打开一条会话会自动标为已读；正文是纯文本（后端 body 是 varchar，没有富文本）。
      </p>
    </>
  );
}

// ── 四档通知 ───────────────────────────────────────────────────

const KIND_ACTION: Record<string, string> = {
  reply: '回复了我',
  mention: '在回复里 @ 了我',
  like: '赞了我',
  reward: '给我打赏',
  review: '我的帖子有了审核结果',
  sanction: '我的账号被处罚',
  system: '发来一条系统通知',
};

/** 取值与迁移 0004 的 ck_topics_review_state 逐字相同 */
const REVIEW_STATE: Record<string, string> = {
  pending: '仍在审核',
  approved: '已通过',
  rejected: '未通过',
};

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 这一条的正文（拿不到就不显示，不编）—— 后端 payload 里没有的字段不假装有。 */
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

function NoticesPane({ kind }: { kind: string }) {
  const qc = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: [...qk.notifications(), kind],
    queryFn: ({ pageParam, signal }) => fetchNotifications({ kind, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  function refresh() {
    void qc.invalidateQueries({ queryKey: qk.notifications() });
    void qc.invalidateQueries({ queryKey: qk.unread() });
  }

  const markOne = useMutation({ mutationFn: (id: string) => markNotificationsRead({ ids: [id] }), onSuccess: refresh });
  const removeOne = useMutation({ mutationFn: (id: string) => deleteNotification(id), onSuccess: refresh });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  // 选中档由调用方归一过（resolveNoticeKind），所以这里按值域精确找，找不到就是第一档
  const current = NOTICE_KINDS.find((k) => k.kinds.join(KIND_SEP) === kind) ?? NOTICE_KINDS[0]!;

  return (
    <NoticeList
      title={current.label}
      hint={items.length > 0 ? '共 ' + items.length + ' 条' : undefined}
      empty={
        list.isPending ? (
          <Loading what='通知' />
        ) : list.isError ? (
          <ErrorState what='通知' error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <Empty
            icon={Inbox}
            title='这一档还没有通知'
            hint='被回复、被点赞、被 @ 时会出现在这里；读掉之后左边的未读计数会归零。'
          />
        )
      }
    >
      {items.map((n) => {
        const detail = detailOf(n);
        const href = linkOf(n);
        return (
          <NoticeRow
            key={n.id}
            actors={[{ nickname: n.actor?.nickname ?? '系统', avatar: n.actor?.avatar }]}
            action={(KIND_ACTION[n.kind] ?? n.kind) + (n.read_at ? '' : '（未读）')}
            body={detail}
            time={formatTime(n.created_at)}
            actions={[
              ...(n.read_at
                ? []
                : [
                    {
                      key: 'read-' + n.id,
                      label: '标为已读',
                      icon: Check,
                      onClick: () => markOne.mutate(n.id),
                    },
                  ]),
              { key: 'delete-' + n.id, label: '删除', icon: Trash2, danger: true, onClick: () => removeOne.mutate(n.id) },
            ]}
            trailing={
              href ? (
                <a
                  data-testid={'notification-' + n.id}
                  href={href}
                  className='flex items-center gap-1 rounded-[3px] text-[13px] text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50'
                >
                  <UserRound aria-hidden className='size-4' />
                  查看
                </a>
              ) : null
            }
          />
        );
      })}
    </NoticeList>
  );
}

// ── 消息设置 ───────────────────────────────────────────────────
//
// 四项逐字照后端 \`notify/deps.go\` 的 NoticeSetting + 迁移 0018 的 CHECK 值域：
// alert / reply_scope / mention_scope / like_alert，值域只有 \`all\` 与 \`none\`
// （**没有 followed**：拍板 §8.3 说本产品没有「关注用户」，所以「关注的人」是一个选不中的假选项）。
// 原先这一整块在产品侧不存在（只在 DevRoom 稿里，且是本地 state）。

function SettingsPane() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['notifications', 'settings'], queryFn: ({ signal }) => fetchNoticeSettings(signal) });

  /** 表就四列、后端也是 PUT 全量，所以改一项就把整份发回去（不做半更新）。 */
  const save = useMutation({
    mutationFn: (next: NoticeSettingsDTO) => updateNoticeSettings(next),
    onSuccess: (next) => qc.setQueryData(['notifications', 'settings'], next),
  });

  if (settings.isPending) return <Loading what='消息设置' />;
  if (settings.isError) {
    return <ErrorState what='消息设置' error={settings.error} onRetry={() => void settings.refetch()} />;
  }

  const s = settings.data;
  const rows: SettingRow[] = [
    {
      key: 'alert',
      kind: 'toggle',
      title: '消息提醒',
      hint: '关闭后，消息将不再进行提醒',
      value: s.alert,
      onChange: (v) => save.mutate({ ...s, alert: v }),
    },
    {
      key: 'reply_scope',
      kind: 'radio',
      title: '回复我的消息提醒',
      hint: '接收谁的评论消息提醒（后端值域只有 all / none）',
      options: [
        { key: 'all', label: '所有人' },
        { key: 'none', label: '不接收任何消息提醒' },
      ],
      value: s.reply_scope,
      onChange: (v) => save.mutate({ ...s, reply_scope: v === 'none' ? 'none' : 'all' }),
    },
    {
      key: 'mention_scope',
      kind: 'radio',
      title: '@ 我的消息提醒',
      hint: '接收谁的 @ 提醒',
      options: [
        { key: 'all', label: '所有人' },
        { key: 'none', label: '不接收任何 @ 提醒' },
      ],
      value: s.mention_scope,
      onChange: (v) => save.mutate({ ...s, mention_scope: v === 'none' ? 'none' : 'all' }),
    },
    {
      key: 'like_alert',
      kind: 'toggle',
      title: '收到的赞',
      hint: '关掉后别人赞我不再提醒',
      value: s.like_alert,
      onChange: (v) => save.mutate({ ...s, like_alert: v }),
    },
  ];

  return (
    <>
      <NoticeSettings rows={rows} />
      <p className='m-0 text-[12px] text-muted-foreground'>
        {save.isPending ? '正在保存…' : save.isError ? '保存失败，改回上一次的值再试一次。' : '改动会立即保存（PUT 全量四字段）。'}
      </p>
    </>
  );
}

// ── 两个页头 ───────────────────────────────────────────────────

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
      description={unread.isSuccess ? (count > 0 ? '未读 ' + count + ' 条' : '没有未读通知') : '别人回复、点赞、@ 你时会出现在这里'}
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

// ── 两条产品路由的入口 ─────────────────────────────────────────
//
// 同一份 NoticeCenter，只是默认档不同：\`/messages\` 默认「我的消息」、\`/notifications\` 默认「回复我的」。
// 顶栏那两个入口（shell.tsx）因此都不用改，而且从任何一页都能走到另一档。

export function MessagesPage() {
  return (
    <div className='flex flex-col gap-4'>
      <MessagesHeader />
      <NoticeCenter panel='messages' />
    </div>
  );
}

/** 路由 \`/notifications\` 的入口：\`routes/notifications.tsx\` 只做一次转出（版面只有这一份）。 */
export function NotificationsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <NoticesHeader />
      <NoticeCenter panel='notices' />
    </div>
  );
}
