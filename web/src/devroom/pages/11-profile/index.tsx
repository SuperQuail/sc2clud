import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { useState } from 'react';
import { MapPin, MessageSquare, MoreHorizontal, UserPlus } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { TopicRow, type TopicRowData } from '@/ui/topic/topic-row';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';

// DevRoom 11 · 个人主页（带设置）
// 布局照主流站点（GitHub / B 站空间 / Discourse 用户页）的**共同结构**：
//   封面带 → 头像压在下边缘 → 名字与徽标 → 账号信息 → 简介 → **统计行** → 标签页 → 内容 + 右栏。
// 上一版只有「头像 + 名字 + 一行数字 + 标签页」，没有封面与视觉锚点，所以显得没头没尾。
// 控件仍然全部复用：TopicRow（主题行）与 NoticeSettings（设置面板）都来自其它业务。
const TOPICS: TopicRowData[] = [
  {
    id: 201,
    title: '第三章「余烬」发布公告与更新日志',
    tags: [{ text: '公告', type: TagType.MAIN }, { text: '第三章' }],
    author: { nickname: '唐天', avatar: assetUrl('miyin-portrait-320.webp'), role: { key: 'admin', name: '管理员' }, title: { name: '执政官', color: '#2563eb' } },
    replies: 128,
    views: 4203,
    lastReplyAt: '3 分钟前',
  },
  {
    id: 202,
    title: '存档兼容性说明（装过第二章的直接进游戏）',
    tags: [{ text: '公告' }],
    author: { nickname: '唐天', avatar: assetUrl('miyin-portrait-320.webp'), role: { key: 'admin', name: '管理员' } },
    replies: 64,
    views: 3310,
    lastReplyAt: '昨天',
  },
  {
    id: 203,
    title: '关于第 11 关菌毯推进速度的调整说明',
    tags: [{ text: '讨论' }],
    author: { nickname: '唐天', avatar: assetUrl('miyin-portrait-320.webp'), title: { name: '执政官', color: '#2563eb' } },
    replies: 42,
    views: 1180,
    lastReplyAt: '2 天前',
  },
];

const FOLLOWING = ['林诗', '某小X', '新来的', '夜航星'];

export default function ProfilePage() {
  const [tab, setTab] = useState('topics');
  const [visibility, setVisibility] = useState('public');
  const [showTitle, setShowTitle] = useState(true);
  const [blocked, setBlocked] = useState<string[]>([]);

  const settings: SettingRow[] = [
    {
      key: 'visibility',
      kind: 'radio',
      title: '主页可见性',
      hint: '谁能查看你的主题与回复',
      options: [
        { key: 'public', label: '所有人' },
        { key: 'members', label: '仅登录用户' },
        { key: 'private', label: '仅自己' },
      ],
      value: visibility,
      onChange: setVisibility,
    },
    { key: 'showTitle', kind: 'toggle', title: '在主页展示我的头衔', value: showTitle, onChange: setShowTitle },
    {
      key: 'blocked',
      kind: 'tags',
      title: '屏蔽词',
      hint: '默认是空的，只由你自己添加',
      items: blocked,
      addLabel: '添加屏蔽词',
      onAdd: () => setBlocked((v) => [...v, '屏蔽词' + (v.length + 1)]),
      onRemove: (t) => setBlocked((v) => v.filter((x) => x !== t)),
    },
  ];

  return (
    <div className='flex flex-col gap-5'>
      {/* 身份卡：封面 + 头像压边 + 统计行 —— 主流个人页的共同结构 */}
      <Island withoutPaddings>
        <div className='relative overflow-hidden'>
          <img src={assetUrl('starcraft/sc2-battle.webp')} alt='' className='h-40 w-full object-cover' />
          <span aria-hidden className='absolute inset-0 bg-gradient-to-t from-background to-transparent' />
        </div>
        <div className='flex flex-col gap-5 px-6 pb-5'>
          <div className='-mt-10 flex flex-wrap items-end justify-between gap-4'>
            <span className='rounded-full ring-4 ring-background'>
              <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='xl' />
            </span>
            <span className='flex flex-wrap items-center gap-2 pb-1'>
              <Button primary icon={icon16(UserPlus)}>关注</Button>
              <Button icon={icon16(MessageSquare)}>发私信</Button>
              <Button icon={icon16(MoreHorizontal)} aria-label='更多操作' />
            </span>
          </div>
          <div className='flex flex-col gap-2'>
            <span className='flex flex-wrap items-center gap-2'>
              <Username nickname='唐天' size='xl' strong />
              <RoleBadge role={{ key: 'admin', name: '管理员' }} />
              <TitleBadge title={{ name: '执政官', color: '#2563eb' }} />
            </span>
            <span className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground'>
              <span>@tangtian</span>
              <span>· 2024 年 3 月加入</span>
              <span className='flex items-center gap-1'>
                <MapPin aria-hidden className='size-3.5' />
                上海
              </span>
            </span>
            <p className='max-w-[65ch] text-[15px] leading-[1.6] text-muted-foreground'>
              战役作者，负责关卡设计与剧情。有问题直接回复，我每天都在。
            </p>
          </div>
          <div className='flex flex-wrap items-center gap-8 border-t border-border pt-4'>
            {[
              { n: '42', label: '主题' },
              { n: '318', label: '回复' },
              { n: '1.2k', label: '获赞' },
              { n: '86', label: '关注者' },
            ].map((s) => (
              <span key={s.label} className='flex items-baseline gap-1.5'>
                <span className='text-[20px] leading-none font-semibold tabular-nums text-foreground'>{s.n}</span>
                <span className='text-[13px] text-muted-foreground'>{s.label}</span>
              </span>
            ))}
          </div>
        </div>
      </Island>

      <Tabs selected={tab} onSelect={(id: string) => setTab(String(id))}>
        <Tab id='topics' title='主题 42' />
        <Tab id='replies' title='回复 318' />
        <Tab id='starred' title='收藏 12' />
        <Tab id='settings' title='设置' />
      </Tabs>

      <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]'>
        <div className='flex flex-col gap-4'>
          {tab === 'topics' ? (
            <Island withoutPaddings>
              {TOPICS.map((t) => (
                <TopicRow key={t.id} topic={t} />
              ))}
            </Island>
          ) : null}
          {tab === 'settings' ? <NoticeSettings rows={settings} /> : null}
          {tab === 'replies' || tab === 'starred' ? (
            <Island withoutPaddings>
              <div className='flex flex-col items-center gap-2 px-4 py-12 text-center'>
                <span className='text-[15px] text-foreground'>这里还没有内容</span>
                <span className='text-[13px] text-muted-foreground'>只有本人可见的内容不会出现在这里</span>
              </div>
            </Island>
          ) : null}
        </div>

        {/* 右栏：徽章与关系 —— 个人页的信息补充位 */}
        <aside className='flex flex-col gap-3'>
          <Island withoutPaddings>
            <div className='flex flex-col gap-3 p-4'>
              <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>徽章</span>
              <span className='flex flex-wrap items-center gap-2'>
                <RoleBadge role={{ key: 'admin', name: '管理员' }} />
                <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='sm' />
                <Tag tagType={TagType.SUCCESS}>首届地图大赛冠军</Tag>
              </span>
            </div>
          </Island>
          <Island withoutPaddings>
            <div className='flex flex-col gap-3 p-4'>
              <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>关注的人</span>
              {FOLLOWING.map((n) => (
                <span key={n} className='flex items-center gap-2'>
                  <UserAvatar name={n} size='sm' />
                  <Username nickname={n} size='sm' />
                </span>
              ))}
            </div>
          </Island>
        </aside>
      </div>
    </div>
  );
}
