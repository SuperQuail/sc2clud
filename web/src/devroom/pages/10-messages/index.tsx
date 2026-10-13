import { useState } from 'react';
import { MessageSquare, Settings, ThumbsUp, AtSign, Bell, Send } from 'lucide-react';
import { appPath, assetUrl } from '@/lib/url';
import { NoticeNav, type NoticeNavItem } from '@/ui/message/notice-nav';
import { NoticeLayout } from '@/ui/message/notice-layout';
import { NoticeList } from '@/ui/message/notice-list';
import { NoticeRow } from '@/ui/message/notice-row';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { MessagesPanel } from './messages-panel';

// DevRoom 10 · 信息中心（参考 B 站消息中心的结构）
// **这一页只做组合**：控件在 src/ui/message/ 里，全是数据驱动的通用件（不认识「消息中心」这个业务）。
// 所以这里的 mock 数据、导航项、设置项都放在页面里——换一个业务场景可以完全复用同一批控件。
// 私信（一对一）是**两栏会话界面**，在同目录 messages-panel.tsx 里（左栏会话列表 + 右栏聊天区）。

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
  const [peer] = useState(() => new URLSearchParams(window.location.search).get('peer'));
  const [privacy, setPrivacy] = useState('all');
  const [notice, setNotice] = useState(true);
  const [blocked, setBlocked] = useState<string[]>(['广告', '代练']);

  const settings: SettingRow[] = [
    { key: 'notice', kind: 'toggle', title: '消息提醒', hint: '关闭后，消息将不再进行提醒', value: notice, onChange: setNotice },
    {
      key: 'reply',
      kind: 'radio',
      title: '回复我的消息提醒',
      hint: '接收谁的评论消息提醒',
      options: [
        { key: 'all', label: '所有人' },
        { key: 'followed', label: '关注的人' },
        { key: 'none', label: '不接收任何消息提醒' },
      ],
      value: privacy,
      onChange: setPrivacy,
    },
    {
      key: 'blocked',
      kind: 'tags',
      title: '消息屏蔽词',
      hint: '添加后，将不再接受包含屏蔽词的消息',
      items: blocked,
      addLabel: '添加屏蔽词',
      onAdd: () => setBlocked((v) => [...v, '新屏蔽词' + (v.length + 1)]),
      onRemove: (t) => setBlocked((v) => v.filter((x) => x !== t)),
    },
  ];

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
      {panel === 'messages' ? <MessagesPanel initialPeer={peer} /> : null}

      {panel === 'replies' ? (
        <NoticeList title='回复我的' hint='共 2 条'>
          <NoticeRow
            actors={[{ nickname: '长司青' }]}
            action='回复了我的评论'
            body='回复 @Minecraft唐天：牛是谁，好奇请问一下'
            excerpt='Minecraft唐天：还有牛的事[笑哭] 不过牛对月枫确实够意思'
            time='2026年10月11日 19:20'
            actions={[
              { key: 'reply', label: '回复', icon: MessageSquare, onClick: () => {} },
              { key: 'like', label: '点赞', icon: ThumbsUp, onClick: () => {} },
            ]}
          />
          <NoticeRow
            actors={[{ nickname: '林星尹', avatar: assetUrl('miyin-wink-260.webp') }]}
            action='回复了我的评论'
            body='回复 @Minecraft唐天：牛哥跟月枫结婚的时候记得来[汤圆]'
            excerpt='Minecraft唐天：还有牛的事[笑哭] 不过牛对月枫确实够意思'
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
            actors={[{ nickname: '秋枫了鸦' }]}
            action='在评论中@了我'
            body='@废黄书 @起航之银lsitian @Minecraft唐天 @御坂14831号 @云隐dayo'
            time='2026年10月9日 20:17'
            actions={[{ key: 'reply', label: '回复', icon: MessageSquare, onClick: () => {} }]}
          />
        </NoticeList>
      ) : null}

      {panel === 'likes' ? (
        <NoticeList title='收到的赞' hint='共 3 条'>
          <NoticeRow
            actors={[{ nickname: '台风法修' }, { nickname: '佚名用户xxx' }]}
            action='等总计 1321 人赞了我的评论'
            time='今天 20:26'
          />
          <NoticeRow
            actors={[{ nickname: 'Charles-坏坏' }, { nickname: '哈哈哈哈在吃鸽子' }]}
            action='等总计 13 人赞了我的评论'
            time='今天 19:48'
            actions={[
              { key: 'delete', label: '删除该通知', danger: true, onClick: () => {} },
              { key: 'mute', label: '不再通知', onClick: () => {} },
            ]}
          />
          <NoticeRow
            actors={[{ nickname: '冰绒の某猫' }, { nickname: 'little白团子' }]}
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
              您好，您在 BV11KSkBjEq6 下评论被举报涉嫌违规，经核实已被移除。请自觉遵守社区公约，良好的社区氛围需要大家一起维护。
              <a href={appPath('rules')} className='ml-1 rounded-[3px] text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50'>查看详情</a>
            </p>
          </div>
        </NoticeList>
      ) : null}

      {panel === 'settings' ? <NoticeSettings rows={settings} /> : null}
    </NoticeLayout>
    </div>
  );
}
