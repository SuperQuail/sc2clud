import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
// ButtonSet 是**默认导出**（命名导出在这个包里不存在，typecheck 直接报 TS2614）
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Coffee, FolderOpen, Heart, Image as ImageIcon, MapPin, MessageSquare, MoreHorizontal, QrCode, Star, UserPlus, UserRound } from 'lucide-react';
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

// 赞助入口（对照 12.4–12.7 的展示侧 + 用户反馈「主页没有赞助按钮」）。
// 与帖子页的 reward-panel **同款**：一大颗 --vivid-accent 按钮（白字、≥44px、15px）+ 一行 11px 说明，
// 点开后**在这个格子里就地展开**（渠道 → 收款码 → 文案 → 登记），不跳转、也不是常驻红块。
const SPONSOR_CHANNELS = [
  { id: 'wechat', label: '微信', notice: '扫码后请在备注里写上你的昵称，作者好对上号。' },
  { id: 'alipay', label: '支付宝', notice: '支付宝扫码，备注可以留空。' },
  { id: 'afdian', label: '爱发电', notice: '爱发电支持一次性与按月两种，随你方便。' },
];

// 看别人主页 / 看自己主页是两种情形（本轮只做文案分支，isSelf 由页面内的 mock 开关给）：
//   别人 → 「赞助 TA」大按钮；自己 → 「设置我的收款码」（自己给自己打赏是荒谬的）。
// 没有收款码时按钮**保留但禁用** + title 说明原因（与帖子页 reward-panel 同一条规矩：
// 藏掉入口，作者就永远等不到想支持的人）。
type SponsorView = { heading: string; button: string; hint: string; disabledHint: string };
const SPONSOR_VIEW: Record<'other' | 'self', SponsorView> = {
  other: {
    heading: '赞助 TA',
    button: '赞助 TA',
    hint: '打赏是纯自愿的，不解锁任何东西。',
    disabledHint: 'TA 还没开启收款码。按钮保留但禁用——入口本身说明「这个站点可以打赏」，藏掉它作者就永远等不到想支持的人。',
  },
  self: {
    heading: '我的赞助',
    button: '设置我的收款码',
    hint: '收款码在个人设置里挂；打赏渠道随时可关，关掉后主页不显示入口。',
    disabledHint: '你还没挂收款码。按钮保留但禁用——挂上之后别人才能在这里支持你。',
  },
};

function SponsorCard({ isSelf, channels }: SponsorDemo) {
  const view = SPONSOR_VIEW[isSelf ? 'self' : 'other'];
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(channels[0]?.id ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [settingsHit, setSettingsHit] = useState(false);
  const active = channels.find((c) => c.id === activeId) ?? channels[0];
  const hasChannel = channels.length > 0;

  return (
    <Island withoutPaddings>
      <div className='flex flex-col gap-2 p-4'>
        <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>{view.heading}</span>
        {/* 大按钮（≥44px、橙底白字）：图标走 children 里的 span——icon16 会把它压成 16px；
            高度与字号用 ! 覆盖 Ring 的默认值；inline={false} 才能拿到整块宽度。 */}
        <Button
          inline={false}
          primary
          aria-expanded={isSelf ? undefined : open}
          disabled={!hasChannel}
          title={hasChannel ? undefined : view.disabledHint}
          iconRight={hasChannel && !isSelf ? icon16(open ? ChevronUp : ChevronDown) : undefined}
          onClick={() => (isSelf ? setSettingsHit(true) : setOpen((v) => !v))}
          className='!h-11 w-full !border-[var(--vivid-accent)] !bg-[var(--vivid-accent)] !text-[15px] !text-white'
        >
          <span className='inline-flex items-center gap-2'>
            <Coffee aria-hidden className='size-5' />
            {view.button}
          </span>
        </Button>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>{view.hint}</p>

        {!hasChannel ? (
          <p className='text-[11px] leading-relaxed text-muted-foreground'>{view.disabledHint}</p>
        ) : isSelf ? (
          settingsHit ? (
            <p className='rounded-md bg-muted/50 px-2 py-2 text-[11px] leading-relaxed text-muted-foreground'>
              已进入「个人设置 · 收款码」（mock）。真实页面跳到 /settings 的收款码分区。
            </p>
          ) : null
        ) : open ? (
          <div className='flex flex-col gap-3 border-t border-border pt-3'>
            <span className='flex flex-wrap items-center gap-1.5'>
              {channels.map((c) => (
                <Button key={c.id} ghost active={c.id === active?.id} onClick={() => setActiveId(c.id)}>
                  {c.label}
                </Button>
              ))}
            </span>

            <span className='flex flex-col items-center gap-2'>
              <span aria-hidden className='grid h-[132px] w-[132px] place-items-center rounded-md bg-muted ring-1 ring-border'>
                <QrCode aria-hidden className='size-16 text-muted-foreground' />
              </span>
              <span className='inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
                <QrCode aria-hidden className='size-3' />
                {active?.label}收款码 · 扫码或长按识别
              </span>
            </span>

            <p className='rounded-md bg-muted/50 px-2 py-2 text-[11px] leading-relaxed text-muted-foreground'>{active?.notice}</p>

            <Button
              inline={false}
              icon={confirmed ? icon16(Check) : undefined}
              disabled={confirmed}
              onClick={() => setConfirmed(true)}
              className='w-full'
            >
              {confirmed ? '已登记，等作者核对' : '我已完成打赏'}
            </Button>
            {confirmed ? (
              <p className='text-[11px] leading-relaxed text-muted-foreground'>
                已生成一条 pending 申报（POST /api/v1/rewards），作者确认收款、管理员核验后才会出现在 TA 的主页收入里。
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Island>
  );
}

// ?sponsor=other|self|none —— 只影响 DevRoom 的演示态：两态（看别人 / 看自己）+ 无收款码的空态。
// 真实页面里 isSelf 由「当前登录者 handle 是否等于 /u/{handle}」决定，channels 来自
// GET /api/v1/users/{handle}/channels（作者关掉展示开关时后端返回空数组）。
type SponsorDemo = { isSelf: boolean; channels: Array<(typeof SPONSOR_CHANNELS)[number]> };

function readSponsorDemo(): SponsorDemo {
  const v = new URLSearchParams(location.search).get('sponsor');
  if (v === 'self') return { isSelf: true, channels: SPONSOR_CHANNELS };
  if (v === 'none') return { isSelf: false, channels: [] };
  return { isSelf: false, channels: SPONSOR_CHANNELS };
}

export default function ProfilePage() {
  const [tab, setTab] = useState('posts');
  const [sponsorDemo, setSponsorDemo] = useState<SponsorDemo>(readSponsorDemo);
  // 封面可自定义：默认给一张，之后接入用户上传（与头像同一个上传控件）
  // 封面素材必须是**横构图**：原来用 starcraft/zerg.webp（64x64）拉到 1440x160 只能放大裁剪 → 一块糊色。
  // 现在默认 sc2-battle.webp（1200x953 插画），「更换封面」在它和 sc2-logo.webp（240x101 横幅）之间切。
  const [cover, setCover] = useState<string>(assetUrl('starcraft/sc2-battle.webp'));
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

  const sponsorStates: Array<{ key: string; label: string; demo: SponsorDemo }> = [
    { key: 'other', label: '看别人主页（有收款码）', demo: { isSelf: false, channels: [...SPONSOR_CHANNELS] } },
    { key: 'self', label: '看自己主页', demo: { isSelf: true, channels: [...SPONSOR_CHANNELS] } },
    { key: 'none', label: '别人没挂收款码', demo: { isSelf: false, channels: [] } },
  ];

  return (
    <div className='flex flex-col gap-3 sm:gap-4'>
      {/* DevRoom 演示开关：真实页面没有它——isSelf 来自当前登录者，channels 来自接口 */}
      <section
        aria-label='赞助入口演示'
        className='flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-border px-3 py-2'
      >
        <span className='text-[11px] font-medium tracking-wide text-muted-foreground'>DevRoom 演示 · 赞助入口</span>
        <ButtonSet>
          {sponsorStates.map((s) => (
            <Button
              key={s.key}
              active={s.demo.isSelf === sponsorDemo.isSelf && s.demo.channels.length === sponsorDemo.channels.length}
              onClick={() => setSponsorDemo(s.demo)}
            >
              {s.label}
            </Button>
          ))}
        </ButtonSet>
        <span className='ml-auto text-[11px] text-muted-foreground'>
          真实页面：isSelf 看登录者与主页 handle 是否同一个人；channels 由接口给
        </span>
      </section>

      {/* ⚠️ 首屏预算：这一页的 hero 高度决定右栏第一格（赞助入口）能不能落在 1440x900 内。
          来历：封面 224px（h-56/sm:h-64）时它被顶出首屏（当时右栏要到首屏底部才开始，按钮看不见）；
          压到 160px（h-40）+ 根 gap 20→12/16 之后才装进来。
          任何人往 hero 加内容 / 换更高的封面 / 调大字号，都要重新量一次按钮 bottom 是否仍 <= 900
          （用 CDP 量，不要目测）。
          **注意真实壳的页头高度与 DevRoom 不同，所以「当前值」不要写进注释——写「怎么量」，不写「量到多少」。** */}
      {/* isolate：建独立层叠上下文，壁纸两层的 -z-10 才落在「section 背景之上、内容之下」，
          否则 -z-10 跑到 section 背景后面，壁纸直接看不见（踩过）。
          flow-root：**壁纸改成绝对定位之后，身份卡的 -mt-20 会向上穿透 section**（没有块级内容挡着就会发生
          margin collapse），整个 section 被顶高 80px、头像行被 overflow-hidden 裁掉（踩过）。
          flow-root 建立 BFC 挡住这次外边距合并。 */}
      <section className='relative isolate flow-root overflow-hidden rounded-xl border border-border bg-background'>
        {/* 壁纸**铺满整个 hero 方框**，不是只铺那条 160px 的带子。
            之前是「160px 的 <img> + 下面接卡片」，方框下半部分自然没有壁纸 —— 用户看到的
            「只有一半」就是这么来的（另一半原因是原素材 zerg.webp 只有 64x64，放大即糊）。
            现在：绝对定位的壁纸层 + 一层向下渐隐到页面底的遮罩，身份卡浮在上面，
            **hero 总高度不变**（首屏预算那条约束见下面的注释）。 */}
        {/* 两层都用 -z-10 明确压到内容之下：只靠 DOM 顺序时，绝对定位的图会盖住后面 relative 的卡片 */}
        <img src={cover} alt='' className='pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover' />
        <span
          aria-hidden
          className='pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-background/35 via-background/80 to-background'
        />
        {/* 撑高用的占位条：壁纸是绝对定位、不参与布局，少了它 hero 只能由身份卡撑，
            身份卡的 -mt-20 就会把它自己顶到 hero 之外（头像行被裁剪）。144px（h-36）= 身份卡上方的
            可见壁纸条高度，**它就是 hero 预算**：改大就等于把赞助按钮往首屏外推，改前先量。 */}
        <div aria-hidden className='h-36' />
        {/* 「更换封面」直接绝对定位在 hero 右上角（z-20）：放进内层 relative 时它会被上移的身份卡压住，
            只露出一角、点不到。按钮浮在壁纸上，原来没给底 —— 浅色下是深蓝字、深色下是浅蓝字，
            壁纸一浅（sc2-battle 的天空）就看不清，所以补一层卡片色 + 轻微模糊把它托起来。 */}
        <span className='absolute right-3 top-3 z-20 rounded-md bg-background/85 backdrop-blur-sm'>
          <Button
            data-testid='change-cover'
            icon={icon16(ImageIcon)}
            onClick={() => setCover((c) => (c.includes('sc2-battle') ? assetUrl('starcraft/sc2-logo.webp') : assetUrl('starcraft/sc2-battle.webp')))}
          >
            更换封面
          </Button>
        </span>

        {/* 身份卡：实色卡面压在壁纸上（原来是 bg-background/70 + backdrop-blur，壁纸铺满之后
            透过磨砂会花掉，正文与徽标全在卡里，可读性优先） */}
        {/* mb-2 而不是 mb-4：hero 现在还要装 144px 壁纸条，这 8px 是补给首屏预算的 */}
        <div className='relative z-10 mx-4 -mt-20 mb-2 flex flex-col gap-5 rounded-xl border border-border bg-background p-5'>
          <div className='flex flex-wrap items-end justify-between gap-4'>
            <span className='rounded-full ring-4 ring-background'>
              <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='xl' />
            </span>
            <span className='flex flex-nowrap items-center gap-2'>
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

        {/* 右栏：赞助 → 徽章 → 关系。
            赞助放第一格：它是这个页面唯一的转化点（读完之后「想支持一下」的那一秒），
            徽章与关注的人是补充信息，晚一步看到不影响什么。 */}
        <aside className='flex flex-col gap-3'>
          <SponsorCard isSelf={sponsorDemo.isSelf} channels={sponsorDemo.channels} />
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