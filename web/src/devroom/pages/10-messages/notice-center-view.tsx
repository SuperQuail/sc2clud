import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { BellOff, Check, Inbox, Send, Trash2, UserRound } from 'lucide-react';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { useLiveNotices } from '@/lib/query/live';
import { formatTime } from '@/lib/format';
import { icon16 } from '@/ui/icons';
import { NoticeLayout } from '@/ui/message/notice-layout';
import { NoticeList } from '@/ui/message/notice-list';
import { NoticeNav } from '@/ui/message/notice-nav';
import { NoticeRow } from '@/ui/message/notice-row';
import { NoticeSettings as SettingsForm, type SettingRow } from '@/ui/message/notice-settings';
import { UserAvatar } from '@/ui/user/avatar';
import type { NoticeSettings as NoticeSettingsDTO } from '@/lib/api/social';
import { Empty } from '@/ui/state/empty';
import { ErrorState, Loading } from '@/routes/_parts/state';
import { MessagesPanel, plainText } from './messages-panel';
import { PeerPicker } from './peer-picker';
import type { Peer } from './types';
import {
  KIND_ACTION,
  NOTICE_KINDS,
  noticeDetail,
  noticeLink,
  noticeNav,
  type ConversationRow,
  type NoticeSources,
  type Panel,
} from './notice-logic';

// **信息中心这一屏的版面（唯一实现）**：左栏 NoticeNav + 右栏三档面板。
//
// 谁渲染它：真站 routes/messages.tsx（/messages 与 /notifications，接真端点）与
// DevRoom 10-messages（结构性假数据）。两个入口喂同一批 props，所以同一档看到的 DOM 逐字相同
// —— 这也是清单 §0「两个地方看同一个页面完全一样」的落点。
//
// **它不认路由、不读 URL**：档位（panel/kind）、当前会话（peer）都由宿主给，动作也由宿主回写。
// 「点击改 URL」那一半留在宿主里，是因为房间没有 react-router（它只认 ?page=），
// 而 View 一旦 import react-router，房间就渲染不了。
//
// 字段名照后端抄（notify/types.go 的 NotificationDTO、message/types.go 的 Conversation/Message），
// 不照设计稿 mock 抄。

const KIND_SEP = ',';

export type NoticeCenterViewProps = {
  panel: Panel;
  /** 通知档位（已由 resolveNoticeKind 归一）；panel !== 'notices' 时它只用于导航键 */
  kind: string;
  /** 当前会话（对方的 handle）；null = 还没选 */
  peer?: string | null;
  /** 点导航：宿主把它写进 URL */
  onNav: (key: string) => void;
  /** 点会话：宿主把它写进 URL（并标已读） */
  onPeer: (handle: string) => void;
  sources: NoticeSources;
  /** 登录态由宿主给（View 不读 session 的全局查询）：未登录时私信档只画空态与登录入口 */
  session: { isLoading: boolean; loggedIn: boolean; nickname: string; avatar?: string | null };
  /** 页头由宿主给（两个入口的页头不同，但版面相同）；缺省留空 */
  header?: ReactNode;
  /** 各档的空态覆盖（宿主给 Loading / ErrorState / Empty）；缺省由 BuildInStates 兜 */
  messagesEmpty?: ReactNode;
  className?: string;
};

export function NoticeCenterView({
  panel,
  kind,
  peer = null,
  onNav,
  onPeer,
  sources,
  session,
  header,
  messagesEmpty,
  className,
}: NoticeCenterViewProps) {
  const nav = noticeNav(panel, kind);
  return (
    <div data-testid='notice-center' className={className ?? 'flex flex-col gap-4'}>
      {header}
      <NoticeLayout nav={<NoticeNav items={nav.items} value={nav.value} onChange={onNav} />}>
        {panel === 'messages' ? (
          <MessagesPane peer={peer} onPeer={onPeer} sources={sources} session={session} emptyOverride={messagesEmpty} />
        ) : null}
        {panel === 'notices' ? <NoticesPane kind={kind} sources={sources} /> : null}
        {panel === 'settings' ? <SettingsPane sources={sources} /> : null}
      </NoticeLayout>
    </div>
  );
}

// ── 我的消息（私信）─────────────────────────────────────────────
//
// 数据源由宿主注入：会话列表（游标分页）、会话（倒序）、发送、打开即已读。
// 选中哪条会话由宿主给（真站是 URL 的 /messages/:handle）—— 分享一条私信地址能直接落到那个会话。

function MessagesPane({
  peer,
  onPeer,
  sources,
  session,
  emptyOverride,
}: {
  peer: string | null;
  onPeer: (handle: string) => void;
  sources: NoticeSources;
  session: NoticeCenterViewProps['session'];
  emptyOverride?: ReactNode;
}) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState('');
  const loggedIn = session.loggedIn;

  const conversations = useInfiniteQuery({
    queryKey: qk.conversations(),
    queryFn: ({ pageParam, signal }) => sources.conversations(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: loggedIn,
  });
  const thread = useQuery({
    queryKey: qk.thread(peer ?? ''),
    queryFn: ({ signal }) => sources.thread(peer ?? '', signal),
    enabled: loggedIn && Boolean(peer),
  });
  // 选人弹层的目录（q 为空时不发请求：后端的搜索词必填）
  const found = useQuery({
    queryKey: qk.search('users', keyword),
    queryFn: ({ signal }) => sources.searchPeers(keyword, signal),
    enabled: picking && keyword !== '',
  });

  const rows = conversations.data?.pages.flatMap((p) => p.items) ?? [];
  const list: ConversationRow[] = rows.slice();
  // 只是「跟没聊过的人开的会话」：不在列表里也要能进（会话页对这种人返回空列表 + peer）
  if (peer && !rows.some((c) => c.peer.handle === peer) && thread.data) {
    list.unshift({ peer: thread.data.peer, messages: [], summary: '', lastAt: '', unread: 0 });
  }
  // 撤回那一格要按 mine 决定给不给：ChatMessage 本身只有 from，而 mine 就是 from:'me'
  const mine = session.nickname;
  const bubbles = (thread.data?.items ?? []).map((m) => ({
    ...m,
    mine: m.from === 'me',
    nickname: m.from === 'me' ? mine : (thread.data?.peer.nickname ?? peer ?? ''),
    avatar: m.from === 'me' ? session.avatar : thread.data?.peer.avatar,
  }));

  const send = useMutation({
    mutationFn: (body: string) => sources.sendMessage!(peer ?? '', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.thread(peer ?? '') });
      void qc.invalidateQueries({ queryKey: qk.conversations() });
    },
  });
  // 撤回（G2）：DELETE /messages/{id} 是「各自删除」——只置我这一侧的标记，对方照常看得见。
  // **不做乐观删除**：游标分页下本地删一条会在下一页留下一个洞，所以等重取。
  const retract = useMutation({
    mutationFn: (id: string) => sources.retractMessage!(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.thread(peer ?? '') });
      void qc.invalidateQueries({ queryKey: qk.conversations() });
    },
  });

  if (session.isLoading) return <Loading what='账号信息' />;
  if (!loggedIn) {
    return (
      <Empty
        title='先登录'
        hint='私信跟着账号走，游客看不到任何会话。'
        action={
          <Button inline={false} height={ControlsHeight.S} href={appPath('login?next=' + encodeURIComponent(appPath('messages')))}>
            去登录
          </Button>
        }
      />
    );
  }

  const peers: Peer[] = found.data ?? [];

  return (
    <>
      <MessagesPanel
        conversations={list}
        selectedHandle={peer}
        messages={bubbles}
        onSelect={onPeer}
        onSend={(payload) => {
          const body = plainText(payload.html).replace(/\n/g, ' ').trim();
          if (body !== '' && sources.sendMessage) send.mutate(body);
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
                onPeer(p.handle);
              }}
              onClose={() => {
                setPicking(false);
                setKeyword('');
              }}
            />
          ) : null
        }
        // 逐条动作槽位（G2）：**只有自己发的**给「撤回」。
        // 后端对「不在我参与的会话里」的消息返回 404，所以别人那条本来也撤不掉 —— 不给入口而不是点了报错。
        renderMessageActions={(m) =>
          m.mine && sources.retractMessage ? (
            <Button
              data-testid={'message-retract-' + m.id}
              inline={false}
              height={ControlsHeight.S}
              ghost
              danger
              icon={icon16(Trash2)}
              loader={retract.isPending && retract.variables === m.id}
              onClick={() => retract.mutate(m.id)}
            >
              撤回
            </Button>
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
          emptyOverride ??
          (!peer ? (
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
          ) : null)
        }
      />

      <p className='m-0 text-[12px] text-muted-foreground'>
        打开一条会话会自动标为已读；正文是纯文本（后端 body 是 varchar，没有富文本）。
      </p>
    </>
  );
}

// ── 四档通知 ───────────────────────────────────────────────────

function NoticesPane({ kind, sources }: { kind: string; sources: NoticeSources }) {
  const qc = useQueryClient();
  // 实时性（L11）：SSE 为主、30 秒轮询兜底。状态要显示出来 —— 实时坏了不能没人知道。
  const live = useLiveNotices(true);
  // 后端**没有** GET /mutes，所以「这一类已经静音了吗」查不到：本屏里点过的记在本地，
  // 免得同一屏对同一个类别反复给入口（刷新后又会显示——那是缺的端点，记在进度文件的阻塞里）。
  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  const list = useInfiniteQuery({
    queryKey: [...qk.notifications(), kind],
    queryFn: ({ pageParam, signal }) => sources.notices(kind, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  function refresh() {
    void qc.invalidateQueries({ queryKey: qk.notifications() });
    void qc.invalidateQueries({ queryKey: qk.unread() });
  }

  const markOne = useMutation({ mutationFn: (id: string) => sources.markNoticesRead!({ ids: [id] }), onSuccess: refresh });
  const removeOne = useMutation({ mutationFn: (id: string) => sources.deleteNotice!(id), onSuccess: refresh });
  // G1「不再通知」：**按类别**静音（PUT /notifications/mutes { type }）。
  // 不做「这一条内容不再通知」的理由见 lib/api/social.ts 的 muteNotificationKind 注释：
  // 按内容静音要的内部 id 前端拿不到（payload.ref_id 是内部 id），送进去是永久静音一条死记录。
  const muteKind = useMutation({ mutationFn: (k: string) => sources.muteKind!(k) });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  // 选中档由调用方归一过（resolveNoticeKind），所以这里按值域精确找，找不到就是第一档
  const current = NOTICE_KINDS.find((k) => k.kinds.join(KIND_SEP) === kind) ?? NOTICE_KINDS[0]!;

  return (
    <NoticeList
      title={current.label}
      hint={
        (items.length > 0 ? '共 ' + items.length + ' 条 · ' : '') +
        (live === 'live' ? '实时同步' : '每 30 秒同步一次（推送未连上）')
      }
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
        const detail = noticeDetail(n);
        const href = noticeLink(n);
        return (
          <NoticeRow
            key={n.id}
            actors={[{ nickname: n.actor?.nickname ?? '系统', avatar: n.actor?.avatar }]}
            action={(KIND_ACTION[n.kind] ?? n.kind) + (n.read_at ? '' : '（未读）')}
            body={detail}
            time={formatTime(n.created_at)}
            actions={[
              // 写动作不给就整条不出入口：房间里没有后端，点了只回执是另一种「看起来成功了」
              ...(n.read_at || !sources.markNoticesRead
                ? []
                : [
                    {
                      key: 'read-' + n.id,
                      label: '标为已读',
                      icon: Check,
                      onClick: () => markOne.mutate(n.id),
                    },
                  ]),
              // 已点过的不再重复给入口（静音是类别级的，同一屏里点第二行等于又发一次同一请求）
              ...(muted.has(n.kind) || !sources.muteKind
                ? []
                : [
                    {
                      key: 'mute-' + n.id,
                      label: '不再通知此类',
                      icon: BellOff,
                      onClick: () => {
                        setMuted((prev) => new Set(prev).add(n.kind));
                        muteKind.mutate(n.kind);
                      },
                    },
                  ]),
              ...(sources.deleteNotice
                ? [{ key: 'delete-' + n.id, label: '删除', icon: Trash2, danger: true, onClick: () => removeOne.mutate(n.id) }]
                : []),
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
// 四项逐字照后端 notify/deps.go 的 NoticeSetting + 迁移 0018 的 CHECK 值域：
// alert / reply_scope / mention_scope / like_alert，值域只有 all 与 none
// （**没有 followed**：拍板 §8.3 说本产品没有「关注用户」，所以「关注的人」是一个选不中的假选项）。

function SettingsPane({ sources }: { sources: NoticeSources }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: qk.noticeSettings(), queryFn: ({ signal }) => sources.settings(signal) });

  /** 表就四列、后端也是 PUT 全量，所以改一项就把整份发回去（不做半更新）。 */
  const save = useMutation({
    mutationFn: (next: NoticeSettingsDTO) => sources.saveSettings!(next),
    onSuccess: (next) => qc.setQueryData(qk.noticeSettings(), next),
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
      <SettingsForm rows={rows} />
      <p className='m-0 text-[12px] text-muted-foreground'>
        {save.isPending ? '正在保存…' : save.isError ? '保存失败，改回上一次的值再试一次。' : '改动会立即保存（PUT 全量四字段）。'}
      </p>
    </>
  );
}

