import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { useState } from 'react';
import { FolderOpen, Heart, Image as ImageIcon, MapPin, MessageSquare, MoreHorizontal, Star, UserPlus, UserRound } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { TopicRow, type TopicRowData } from '@/ui/topic/topic-row';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { IconTabs, type IconTabItem } from '@/ui/nav/icon-tabs';

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

const TABS: IconTabItem[] = [
  { key: 'posts', label: '帖子', icon: <FolderOpen aria-hidden className='size-5' />, count: 42 },
  { key: 'replies', label: '回复', icon: <MessageSquare aria-hidden className='size-5' />, count: 318 },
  { key: 'starred', label: '收藏', icon: <Star aria-hidden className='size-5' />, count: 12 },
  { key: 'liked', label: '赞过', icon: <Heart aria-hidden className='size-5' />, count: 236 },
  { key: 'settings', label: '设置', icon: <UserRound aria-hidden className='size-5' /> },
];

const FOLLOWING = ['林诗', '某小X', '新来的', '夜航星'];

export default function ProfilePage() {
  const [tab, setTab] = useState('posts');
  // 封面可自定义：默认给一张，之后接入用户上传（与头像同一个上传控件）
  const [cover, setCover] = useState<string>(assetUrl('starcraft/zerg.webp'));
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
      {/* 身份卡：**大封面 + 半透明磨砂面板**（参考 B 站空间页）
          封面允许自定义（cover 状态；接上传后即为「更换封面」）；信息面板压在封面下半部，
          用 backdrop-blur 让封面透出来，而不是用实色把图挡住。 */}
      <section className='overflow-hidden rounded-xl border border-border bg-background'>
        <div className='relative'>
          <img src={cover} alt='主页封面' className='h-56 w-full object-cover sm:h-64' />
          <span className='absolute right-4 top-4'>
            <Button
              data-testid='change-cover'
              icon={icon16(ImageIcon)}
              onClick={() => setCover((c) => (c.includes('zerg') ? assetUrl('starcraft/protoss.webp') : assetUrl('starcraft/zerg.webp')))}
            >
              更换封面
            </Button>
          </span>
        </div>

        <div className='relative mx-4 -mt-20 mb-4 flex flex-col gap-5 rounded-xl border border-border bg-background/70 p-5 backdrop-blur-md'>
          <div className='flex flex-wrap items-end justify-between gap-4'>
            <span className='rounded-full ring-4 ring-background'>
              <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='xl' />
            </span>
            <span className='flex flex-wrap items-center gap-2'>
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
              { n: '42', label: '帖子' },
              { n: '318', label: '回复' },
              { n: '1.2k', label: '获赞' },
              { n: '86', label: '关注者' },
            ].map((st) => (
              <span key={st.label} className='flex items-baseline gap-1.5'>
                <span className='text-[20px] leading-none font-semibold tabular-nums text-foreground'>{st.n}</span>
                <span className='text-[13px] text-muted-foreground'>{st.label}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      <IconTabs items={TABS} value={tab} onChange={setTab} ariaLabel='个人主页分区' />

      <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]'>
        <div className='flex flex-col gap-4'>
          {tab === 'posts' ? (
            <Island withoutPaddings>
              {TOPICS.map((t) => (
                <TopicRow key={t.id} topic={t} />
              ))}
            </Island>
          ) : null}
          {tab === 'settings' ? <NoticeSettings rows={settings} /> : null}
          {tab === 'replies' || tab === 'starred' || tab === 'liked' ? (
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
