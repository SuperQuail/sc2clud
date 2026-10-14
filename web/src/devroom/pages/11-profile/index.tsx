import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Island from '@jetbrains/ring-ui-built/components/island/island';
// ButtonSet 是**默认导出**（命名导出在这个包里不存在，typecheck 直接报 TS2614）
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { useRef, useState } from 'react';
import { FolderOpen, Heart, Image as ImageIcon, ImagePlus, MessageSquare, MoreHorizontal, Star, UserPlus, UserRound } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { TopicRow, type TopicRowData } from '@/ui/topic/topic-row';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { IconTabs, type IconTabItem } from '@/ui/nav/icon-tabs';
import { roomHref } from '@/devroom/room-links';
import { AccountPanel, type AvatarHandle } from './account-panel';
import { ProfileHero } from './profile-hero';

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
    author: { nickname: '示范管理员', avatar: assetUrl('miyin/smile-160.webp'), role: { key: 'admin', name: '管理员' }, title: { name: '执政官', color: '#2563eb' } },
    replies: 128,
    views: 4203,
    lastReplyAt: '3 分钟前',
  },
  {
    id: 202,
    title: '存档兼容性说明（装过第二章的直接进游戏）',
    tags: [{ text: '公告' }],
    author: { nickname: '示范管理员', avatar: assetUrl('miyin/smile-160.webp'), role: { key: 'admin', name: '管理员' } },
    replies: 64,
    views: 3310,
    lastReplyAt: '昨天',
  },
  {
    id: 203,
    title: '关于第 11 关菌毯推进速度的调整说明',
    tags: [{ text: '讨论' }],
    author: { nickname: '示范管理员', avatar: assetUrl('miyin/smile-160.webp'), title: { name: '执政官', color: '#2563eb' } },
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

// 统一假名单（完全重构/DevRoom-假数据规范.md）：兵种名，一眼看出是示例
const FOLLOWING = ['陆战队员', '狂热者', '刺蛇', '虫后'];

// 赞助入口（对照 12.4–12.7 的展示侧 + 用户反馈「主页没有赞助按钮」）。
// 与帖子页的 reward-panel **同款**：一大颗 --vivid-accent 按钮（白字、≥44px、15px）+ 一行 11px 说明，
// 点开后**在这个格子里就地展开**（渠道 → 收款码 → 文案 → 登记），不跳转、也不是常驻红块。

// 赞助入口拆到 sponsor-card.tsx（该文件超体量门禁），这里只 import 用它
import { SPONSOR_CHANNELS, SPONSOR_NOTICE, SponsorCard, readSelfView, type SponsorDemo } from './sponsor-card';

export default function ProfilePage() {
  const [tab, setTab] = useState('posts');
  // 「本人 / 别人」是**一个**开关：赞助入口与账号入口（头像/改密码/退出）都看它。
  // 默认本人 —— 页面初始态就该是本人主页（账号那几条入口在本人态才存在，见 readSelfView 的注释）。
  // 必须写成 useState(() => ...)：直接写 readSelfView() 是**立刻求值**，而 useState 只取第一次的值，
  // 重挂载时永远停在首次那一瞬的 query（?sponsor=other 失效 → 看别人主页也放出账号入口）。
  const [selfView, setSelfView] = useState(() => readSelfView());
  const [loggedOut, setLoggedOut] = useState(false);
  // 新头像的预览地址（object URL）。真实页面在上传成功后换成服务端 /img/<hash>。
  const [avatar, setAvatar] = useState<string | null>(null);
  // 头像上传器挂在「设置」标签里；hero 上的「更换头像」通过这个句柄代点，不必把上传器挪出设置面板。
  // 用 ref 不用 state：它不参与渲染，而且按钮的 onClick 拿 ref.current 比读一次 state 更直接。
  const avatarApi = useRef<AvatarHandle | null>(null);
  // 看别人主页时没有「设置」标签：停在它上面（或从本人态切过来）就踢回帖子页。
  // 这里必须写 selfView.isSelf —— 写成 !selfView 是在判那个对象，永假，
  // 于是别人态仍然渲染账号面板（账号入口在别人主页上放出来，是要害）。
  const activeTab = !selfView.isSelf && tab === 'settings' ? 'posts' : tab;
  // 封面素材必须是**横构图**：原来用 starcraft/zerg.webp（64x64）拉到 1440x160 只能放大裁剪 → 一块糊色。
  // 现在默认 sc2-battle.webp（1200x953 插画）。
  // **后端不支持自定义封面**（users 没有封面列、也没有上传端点），所以这一屏不给「点了能换」的假动作：
  // 壁纸是这一张固定的，右上那颗入口保留形状但标成未实现（2026-10-14 用户要求：别在真站上放假入口）。
  const cover = assetUrl('starcraft/sc2-battle.webp');
  const [visibility, setVisibility] = useState('public');
  const [showTitle, setShowTitle] = useState(true);
  const [blocked, setBlocked] = useState<string[]>([]);

  const settings: SettingRow[] = [
    {
      key: 'visibility',
      kind: 'radio',
      title: '主页可见性',
      hint: '谁能查看你的帖子与回复',
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

  const demoStates: Array<{ key: string; label: string; demo: SponsorDemo }> = [
    { key: 'self', label: '看自己主页（有收款码）', demo: { isSelf: true, channels: [...SPONSOR_CHANNELS] } },
    { key: 'self-none', label: '自己没挂收款码（仍渲染设置入口）', demo: { isSelf: true, channels: [] } },
    { key: 'other', label: '看别人主页（有收款码）', demo: { isSelf: false, channels: [...SPONSOR_CHANNELS] } },
    { key: 'none', label: '别人没挂收款码（赞助整块不渲染）', demo: { isSelf: false, channels: [] } },
  ];
  // 看别人主页时没有「设置」标签：那一栏里的账号动作（改密码/退登/换头像）一行都不该出现。
  // 必须写 selfView.isSelf：写成 selfView 是在判**对象**（恒真），过滤永远不生效。
  const tabs = selfView.isSelf ? TABS : TABS.filter((t) => t.key !== 'settings');
  // 头像入口：切到设置标签并**就地打开文件框**（上传器挂载在那边，句柄由它回传）。
  // 读当前值走函数式写法，避免把 avatarApi 塞进依赖数组、每次挂载都重渲染一遍。
  const pickAvatar = () => {
    setTab('settings');
    // 上传器此刻已经挂载（设置面板一直在渲染），ref 里就是它的句柄；open() 打开文件选择框
    avatarApi.current?.open();
  };

  return (
    <div className='flex flex-col gap-3 sm:gap-4'>
      {/* DevRoom 演示开关：真实页面没有它——isSelf 来自当前登录者，channels 来自接口 */}
      <section
        aria-label='赞助入口演示'
        className='flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-border px-3 py-2'
      >
        <span className='text-[11px] font-medium tracking-wide text-muted-foreground'>DevRoom 演示 · 本人主页 / 别人主页</span>
        <ButtonSet>
          {demoStates.map((s) => (
            <Button
              key={s.key}
              active={s.demo.isSelf === selfView.isSelf && s.demo.channels.length === selfView.channels.length}
              onClick={() => setSelfView(s.demo)}
            >
              {s.label}
            </Button>
          ))}
        </ButtonSet>
        {/* 退出登录是**有结果的动作**（回未登录态），所以退出后得有一条能回到演示态的路，否则这一页没法继续走查 */}
        {loggedOut ? (
          <Button data-testid='demo-relogin' onClick={() => setLoggedOut(false)}>
            演示：撤销退出，回到登录态
          </Button>
        ) : null}
        <span className='ml-auto text-[11px] text-muted-foreground'>
          真实页面：isSelf 看登录者与主页 handle 是否同一个人；channels 由接口给
        </span>
      </section>

      {/* 未登录态：真实站点里这时整页都在登录页上，不会看到个人主页。
          房间里只把「你说不清楚到底退没退」这件事说清楚（盲审二号：动作不能静默）。 */}
      {loggedOut ? (
        <section
          role='status'
          data-testid='logged-out-banner'
          className='flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-border px-3 py-2'
        >
          <span className='text-[13px] text-foreground'>你已退出登录（演示）。</span>
          <span className='text-[12px] text-muted-foreground'>
            真实页面：清掉这台设备的会话 cookie，跳到登录页；再发帖、回复、上传都会被拦下。
          </span>
        </section>
      ) : null}

      {/* hero 的版式与那几段长注释都在 profile-hero.tsx：产品路由要**原样复用同一份实现**，
          不是把这 160 行抄到 routes/profile.tsx 里再改一遍（上线设计 P2 决策 2）。 */}
      <ProfileHero
        cover={cover}
        nickname='示范管理员'
        handle='demo-admin'
        joined='2024 年 3 月加入'
        location='上海'
        bio='战役作者，负责关卡设计与剧情。有问题直接回复，我每天都在。'
        avatar={avatar ?? assetUrl('miyin/smile-160.webp')}
        role={{ key: 'admin', name: '管理员' }}
        title={{ name: '执政官', color: '#2563eb' }}
        stats={[
          { value: '42', label: '帖子' },
          { value: '318', label: '回复' },
          { value: '1.2k', label: '获赞' },
          { value: '86', label: '关注者' },
        ]}
        onAvatarPick={selfView.isSelf ? pickAvatar : undefined}
        topActions={
          <>
            {/* 「更换头像」的落点：上传器在「设置」标签里（那里有预览、移除与体积提示），
                这里只负责把人送过去。落在同一个位置、同一档高度，读起来是「封面 / 头像」一对动作。
                只在本人主页出现 —— 看别人主页时换别人的头像既无意义也无权限。 */}
            {selfView.isSelf ? (
              <span className='rounded-md bg-background/85 backdrop-blur-sm'>
                <Button
                  inline={false}
                  height={ControlsHeight.S}
                  data-testid='change-avatar'
                  icon={icon16(ImagePlus)}
                  onClick={pickAvatar}
                >
                  更换头像
                </Button>
              </span>
            ) : null}
            {/* 封面入口**标注为未实现**：后端没有承载它的列与端点，所以这颗是 disabled 的，
                名字里直接写出来 —— 房间里不留「点了没反应」的动作，也不假装它能用。 */}
            <span className='rounded-md bg-background/85 backdrop-blur-sm'>
              <Button
                inline={false}
                height={ControlsHeight.S}
                data-testid='change-cover'
                icon={icon16(ImageIcon)}
                disabled
                title='后端还没有用户封面列与上传端点，这一颗还没接'
              >
                更换封面（未实现）
              </Button>
            </span>
          </>
        }
        actions={
          <>
            <Button primary inline={false} height={ControlsHeight.S} icon={icon16(UserPlus)}>关注</Button>
            <Button ghost inline={false} height={ControlsHeight.S} icon={icon16(MessageSquare)}>发私信</Button>
            <Button ghost inline={false} height={ControlsHeight.S} icon={icon16(MoreHorizontal)} aria-label='更多操作' />
          </>
        }
      />

      <IconTabs items={tabs} value={activeTab} onChange={setTab} ariaLabel='个人主页分区' />

      <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]'>
        <div className='flex flex-col gap-4'>
          {activeTab === 'posts' ? (
            <Island withoutPaddings>
              {/* 链接由调用方给：房子件自己拼路径（appPath('t/'+id)）会把房间用户送到旧站 404；
                  房间没有「按 id 看帖子」的页面，所以统一指向房间内的帖子内容页。 */}
              {TOPICS.map((t) => (
                <TopicRow key={t.id} topic={{ ...t, href: roomHref('12-topic') }} />
              ))}
            </Island>
          ) : null}
          {/* 设置标签页 = 原三块个人设置 + 账号面板（头像/改密码/退出登录）。
              账号面板只在本人态渲染，看别人主页时连「设置」标签都不存在。 */}
          {activeTab === 'settings' ? (
            selfView.isSelf ? (
              <div className='flex flex-col gap-4'>
                <NoticeSettings rows={settings} />
                <AccountPanel
                  avatar={avatar}
                  onAvatar={setAvatar}
                  onAvatarReady={(api) => { avatarApi.current = api; }}
                  onLogout={() => {
                    // 真实页面：POST /api/v1/auth/logout → 清 cookie → 跳登录页。
                    // 这里留两个可观察结果：顶部出现「你已退出登录」，账号动作收起只剩「去登录」。
                    setLoggedOut(true);
                    avatarApi.current = null;
                  }}
                  loggedOut={loggedOut}
                />
              </div>
            ) : (
              <NoticeSettings rows={settings} />
            )
          ) : null}
          {activeTab === 'replies' || activeTab === 'starred' || activeTab === 'liked' ? (
            <Island withoutPaddings>
              <div className='flex flex-col items-center gap-2 px-4 py-12 text-center'>
                <span className='text-[15px] text-foreground'>这里还没有内容</span>
                <span className='text-[13px] text-muted-foreground'>只有本人可见的内容不会出现在这里</span>
              </div>
            </Island>
          ) : null}
        </div>

        {/* 右栏：赞助 → 徽章 → 关系。
            赞助放第一格：它是这个页面唯一的转化点（读完之后「想支持一下」的那一秒），
            徽章与关注的人是补充信息，晚一步看到不影响什么。 */}
        <aside className='flex flex-col gap-3'>
          <SponsorCard isSelf={selfView.isSelf} channels={selfView.channels} notice={SPONSOR_NOTICE} />
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