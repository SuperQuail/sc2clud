import { useState } from 'react';
import { MessageSquare, Settings, ThumbsUp, AtSign, Bell, Send } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { NoticeNav, type NoticeNavItem } from '@/ui/message/notice-nav';
import { NoticeLayout } from '@/ui/message/notice-layout';
import { NoticeList } from '@/ui/message/notice-list';
import { NoticeRow } from '@/ui/message/notice-row';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { UserAvatar } from '@/ui/user/avatar';
import { MessagesPanel, plainText } from './messages-panel';
import { PeerPicker } from './peer-picker';
import { CONVERSATIONS, DIRECTORY, ME } from './mock';
import type { Conversation, Peer } from './types';
import { ProtoLink, roomHref } from '@/devroom/room-links';

// DevRoom 10 · 信息中心（参考 B 站消息中心的结构）
// **这一页只做组合**：控件在 src/ui/message/ 里，全是数据驱动的通用件（不认识「消息中心」这个业务）。
// 所以这里的 mock 数据、导航项、设置项都放在页面里——换一个业务场景可以完全复用同一批控件。
// 私信（一对一）是**两栏会话界面**，在同目录 messages-panel.tsx 里（左栏会话列表 + 右栏聊天区）。
//
// 2026-10-14：MessagesPanel 改成 **prop 驱动**（数据 / 动作 / 选人弹层都由宿主给），本页退化成它的一个宿主，
// 真站（src/routes/messages.tsx）渲染同一个组件 —— mock 只在 `./mock` 里，组件里一份都没有。

const NAV: NoticeNavItem[] = [
  { key: 'messages', label: '我的消息', icon: <MessageSquare aria-hidden className='size-4' /> },
  { key: 'replies', label: '回复我的', icon: <Send aria-hidden className='size-4' /> },
  { key: 'mentions', label: '@ 我的', icon: <AtSign aria-hidden className='size-4' /> },
  { key: 'likes', label: '收到的赞', icon: <ThumbsUp aria-hidden className='size-4' />, count: 3 },
  { key: 'system', label: '系统通知', icon: <Bell aria-hidden className='size-4' /> },
  { key: 'settings', label: '消息设置', icon: <Settings aria-hidden className='size-4' />, groupTitle: '设置' },
];

export default function MessagesPage() {
  // 面板与当前会话都由 URL 指定（?panel=messages&peer=<handle>）：出图与浏览器断言都要用，不靠手点
  const [panel, setPanel] = useState(
    () => new URLSearchParams(window.location.search).get('panel') ?? 'messages',
  );
  const [peer, setPeer] = useState(() => new URLSearchParams(window.location.search).get('peer') ?? CONVERSATIONS[0]?.peer.handle ?? '');
  const [picking, setPicking] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS);

  // 设置项**逐字照后端真源**（forum/internal/notify/deps.go 的 NoticeSetting 四项 +
  // 迁移 0018 的 CHECK 值域），2026-10-14 按 0018 核对后改过两处：
  //   ① 删掉「关注的人」：拍板 §8.3 说本产品没有关注用户，reply_scope 的 CHECK 只有 all / none
  //      （0018_notice_settings.up.sql:24）。留着它就是一个**选不中**的假选项。
  //   ② 补上 mention_scope 与 like_alert：后端本来就有这两项，稿里原先漏了，于是这一屏保不住完整的设置。
  // 「消息屏蔽词」后端没有这个能力（没有表、没有端点），按规矩先从这里撤掉，记进 完全重构/进行中/设计对齐.md。
  const [notice, setNotice] = useState(true);
  const [replyScope, setReplyScope] = useState('all');
  const [mentionScope, setMentionScope] = useState('all');
  const [likeAlert, setLikeAlert] = useState(true);

  const settings: SettingRow[] = [
    { key: 'alert', kind: 'toggle', title: '消息提醒', hint: '关闭后，消息将不再进行提醒', value: notice, onChange: setNotice },
    {
      key: 'reply_scope',
      kind: 'radio',
      title: '回复我的消息提醒',
      hint: '接收谁的评论消息提醒（后端只有 all / none 两个取值）',
      options: [
        { key: 'all', label: '所有人' },
        { key: 'none', label: '不接收任何消息提醒' },
      ],
      value: replyScope,
      onChange: setReplyScope,
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
      value: mentionScope,
      onChange: setMentionScope,
    },
    { key: 'like_alert', kind: 'toggle', title: '收到的赞', hint: '关掉后别人赞我不再提醒', value: likeAlert, onChange: setLikeAlert },
  ];

  const current = conversations.find((c) => c.peer.handle === peer) ?? null;

  /** 打开会话＝把它的未读清掉（真实 IM 的行为）；真站这一步是 POST /messages/{handle}/read */
  function open(handle: string) {
    setPeer(handle);
    setConversations((prev) => prev.map((c) => (c.peer.handle === handle ? { ...c, unread: 0 } : c)));
  }

  function pick(p: Peer) {
    setPicking(false);
    setConversations((prev) =>
      prev.some((c) => c.peer.handle === p.handle)
        ? prev
        : [{ peer: p, messages: [], summary: '还没有消息', lastAt: '刚刚', unread: 0 }, ...prev],
    );
    open(p.handle);
  }

  function send(payload: { json: string; html: string }) {
    const text = plainText(payload.html);
    if (!peer || !text) return;
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.peer.handle === peer
          ? {
              ...c,
              messages: [
                ...c.messages,
                { id: 'local-' + Date.now(), from: 'me' as const, nickname: ME.nickname, avatar: ME.avatar, html: text, time: '刚刚' },
              ],
              summary: text.replace(/\n/g, ' ').slice(0, 24),
              lastAt: '刚刚',
              unread: 0,
            }
          : c,
      );
      // 刚说过话的会话排到最前（真实 IM 的行为）
      const hit = next.find((c) => c.peer.handle === peer);
      return hit ? [hit, ...next.filter((c) => c.peer.handle !== peer)] : next;
    });
  }

  // DevRoom 的导航条被限宽在 1100px；私信是「导航 + 会话列表 + 聊天区」的三列，自己放宽到 1280px 再居中
  // （只作用于本页这一段，不动共享布局）。
  return (
    <div className='relative left-1/2 w-[min(1280px,calc(100vw-32px))] -translate-x-1/2'>
    <p className='mb-2 px-1 text-[11px] leading-relaxed text-muted-foreground'>
      本页的件都来自 src/ui/message/。其中
      <strong className='font-medium text-foreground'>CountBadge</strong>
      （未读数字角标）没有独立入口：它出现在左侧导航每一项后面的计数上（例如「收到的赞 3」），
      以及会话列表里未读会话的角标上。
    </p>
    <NoticeLayout
      nav={<NoticeNav items={NAV} value={panel} onChange={setPanel} title='消息中心' titleIcon={<Send aria-hidden className='size-4' />} />}
    >
      {panel === 'messages' ? (
        <MessagesPanel
          conversations={conversations}
          selectedHandle={peer}
          messages={current?.messages ?? []}
          onSelect={open}
          onSend={send}
          onOpenPicker={() => setPicking(true)}
          picker={() => (picking ? <PeerPicker people={DIRECTORY} existing={conversations.map((c) => c.peer.handle)} onPick={pick} onClose={() => setPicking(false)} /> : null)}
          headerActions={
            current ? (
              <span className='flex items-center gap-3'>
                <a
                  href={roomHref('11-profile')}
                  className='flex items-center gap-2 rounded-[3px] px-1 py-0.5 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  title={'查看 ' + current.peer.nickname + ' 的主页'}
                >
                  <UserAvatar name={current.peer.nickname} src={current.peer.avatar} size='sm' />
                  <span className='text-[13px] text-muted-foreground'>@{current.peer.handle}</span>
                </a>
              </span>
            ) : null
          }
        />
      ) : null}

      {panel === 'replies' ? (
        <NoticeList title='回复我的' hint='共 2 条'>
          <NoticeRow
            actors={[{ nickname: '虫后' }]}
            action='回复了我的评论'
            body='回复 @陆战队员：菌毯推进那套触发器能开源吗'
            excerpt='陆战队员：那张沙漠地形包我用了，崖体拼接很顺'
            time='2026年10月11日 19:20'
            actions={[
              { key: 'reply', label: '回复', icon: MessageSquare, onClick: () => {} },
              { key: 'like', label: '点赞', icon: ThumbsUp, onClick: () => {} },
            ]}
          />
          <NoticeRow
            actors={[{ nickname: '刺蛇', avatar: assetUrl('miyin-wink-260.webp') }]}
            action='回复了我的评论'
            body='回复 @陆战队员：第三章的空投提示我按你的改了'
            excerpt='陆战队员：那张沙漠地形包我用了，崖体拼接很顺'
            time='2026年10月10日 00:19'
            actions={[
              { key: 'reply', label: '回复', icon: MessageSquare, onClick: () => {} },
              { key: 'delete', label: '删除该通知', danger: true, onClick: () => {} },
            ]}
          />
        </NoticeList>
      ) : null}

      {panel === 'mentions' ? (
        <NoticeList title='@ 我的' hint='共 1 条'>
          <NoticeRow
            actors={[{ nickname: '狂热者' }]}
            action='在评论中@了我'
            body='@工蜂 @虚空辉光舰 @陆战队员 @感染虫 @幽灵特工'
            time='2026年10月9日 20:17'
            actions={[{ key: 'reply', label: '回复', icon: MessageSquare, onClick: () => {} }]}
          />
        </NoticeList>
      ) : null}

      {panel === 'likes' ? (
        <NoticeList title='收到的赞' hint='共 3 条'>
          <NoticeRow
            actors={[{ nickname: '医疗兵' }, { nickname: '大和号' }]}
            action='等总计 1321 人赞了我的评论'
            time='今天 20:26'
          />
          <NoticeRow
            actors={[{ nickname: '雷神' }, { nickname: '不朽者' }]}
            action='等总计 13 人赞了我的评论'
            time='今天 19:48'
            actions={[
              { key: 'delete', label: '删除该通知', danger: true, onClick: () => {} },
              { key: 'mute', label: '不再通知', onClick: () => {} },
            ]}
          />
          <NoticeRow
            actors={[{ nickname: '科学球' }, { nickname: '飞龙' }]}
            action='等总计 73 人赞了我的评论'
            time='今天 19:34'
          />
        </NoticeList>
      ) : null}

      {panel === 'system' ? (
        <NoticeList title='系统通知'>
          <div className='flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0'>
            <span className='flex flex-wrap items-baseline gap-2'>
              <span className='text-[15px] font-semibold text-foreground'>《社区隐私政策》修订通知</span>
              <span className='text-[13px] tabular-nums text-muted-foreground'>2026年3月16日 19:00</span>
            </span>
            <p className='text-[15px] leading-[1.6] text-foreground'>
              根据业务开展实际情况，我们于近期更新了《社区隐私政策》中的相关内容，您可以前往【我的 - 设置 - 隐私政策】查看主要更新提示以及更新后的全部内容。
            </p>
          </div>
          <div className='flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0'>
            <span className='flex flex-wrap items-baseline gap-2'>
              <span className='text-[15px] font-semibold text-foreground'>评论存在违规</span>
              <span className='text-[13px] tabular-nums text-muted-foreground'>2025年12月1日 06:11</span>
            </span>
            <p className='text-[15px] leading-[1.6] text-foreground'>
              您好，您在帖子 0192f0a1（自定义地图的触发器写法）下的评论被举报涉嫌违规，经核实已被移除。请自觉遵守社区公约，良好的社区氛围需要大家一起维护。
              <ProtoLink what='版规页' className='ml-1 rounded-[3px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'>查看详情</ProtoLink>
            </p>
          </div>
        </NoticeList>
      ) : null}

      {panel === 'settings' ? <NoticeSettings rows={settings} /> : null}
    </NoticeLayout>
    </div>
  );
}
