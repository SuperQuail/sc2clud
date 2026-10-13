import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Island from '@jetbrains/ring-ui-built/components/island/island';
// ButtonSet 是**默认导出**（命名导出在这个包里不存在，typecheck 直接报 TS2614）
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { useRef, useState } from 'react';
import { FolderOpen, Heart, Image as ImageIcon, ImagePlus, MapPin, MessageSquare, MoreHorizontal, Star, UserPlus, UserRound } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { TopicRow, type TopicRowData } from '@/ui/topic/topic-row';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { IconTabs, type IconTabItem } from '@/ui/nav/icon-tabs';
import { AccountPanel, type AvatarHandle } from './account-panel';

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
import { SPONSOR_CHANNELS, SponsorCard, readSelfView, type SponsorDemo } from './sponsor-card';

export default function ProfilePage() {
  const [tab, setTab] = useState('posts');
  // 「本人 / 别人」是**一个**开关：赞助入口与账号入口（头像/改密码/退出）都看它。
  // 默认本人 —— 页面初始态就该是本人主页（账号那几条入口在本人态才存在，见 readSelfView 的注释）。
  const [selfView, setSelfView] = useState(readSelfView);
  const [loggedOut, setLoggedOut] = useState(false);
  // 新头像的预览地址（object URL）。真实页面在上传成功后换成服务端 /img/<hash>。
  const [avatar, setAvatar] = useState<string | null>(null);
  // 头像上传器挂在「设置」标签里；hero 上的「更换头像」通过这个句柄代点，不必把上传器挪出设置面板。
  // 用 ref 不用 state：它不参与渲染，而且按钮的 onClick 拿 ref.current 比读一次 state 更直接。
  const avatarApi = useRef<AvatarHandle | null>(null);
  // 从「别人主页」切回来时，若停在设置标签上会被下面的推导踢回帖子页
  const activeTab = !selfView && tab === 'settings' ? 'posts' : tab;
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
  // 看别人主页时没有「设置」标签：那一栏里的账号动作（改密码/退登/换头像）一行都不该出现
  const tabs = selfView ? TABS : TABS.filter((t) => t.key !== 'settings');
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

      {/* ⚠️ 首屏预算：这一页的 hero 高度决定右栏第一格（赞助入口）能不能落在 1440x900 内。
          来历：hero 每长高一点，赞助入口就往下走；它曾掉出过首屏（用户报「主页没有赞助按钮」）。
          **现在唯一的旋钮是下面那个 h-36 占位条**（= 身份卡上方可见的壁纸条高度）——
          改它 / 往 hero 加内容 / 换更高的封面 / 调大字号，都要重新量一次按钮 bottom 是否仍 <= 900
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
            现在：绝对定位的壁纸层 + 一层向下渐隐到页面底的遮罩，身份卡浮在上面。
            **代价：hero 高了 136px（214→350）** —— 壁纸条是真实的可见高度，不可能白来。
            赞助按钮当时从 735 掉到 871（仍在首屏内），余量因此变薄，见上面那条首屏预算注释。 */}
        {/* 两层都用 -z-10 明确压到内容之下：只靠 DOM 顺序时，绝对定位的图会盖住后面 relative 的卡片 */}
        <img src={cover} alt='' className='pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover' />
        <span
          aria-hidden
          className='pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-background/0 from-80% to-background/95'
        />
        {/* 撑高用的占位条：壁纸是绝对定位、不参与布局，少了它 hero 只能由身份卡撑，
            身份卡的 -mt-20 就会把它自己顶到 hero 之外（头像行被裁剪）。144px（h-36）= 身份卡上方的
            可见壁纸条高度，**它就是 hero 预算**：改大就等于把赞助按钮往首屏外推，改前先量。 */}
        <div aria-hidden className='h-36' />
        {/* 「更换封面」直接绝对定位在 hero 右上角（z-20）：放进内层 relative 时它会被上移的身份卡压住，
            只露出一角、点不到。按钮浮在壁纸上，原来没给底 —— 浅色下是深蓝字、深色下是浅蓝字，
            壁纸一浅（sc2-battle 的天空）就看不清，所以补一层卡片色 + 轻微模糊把它托起来。 */}
        <span className='absolute right-3 top-3 z-20 flex items-center gap-2'>
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
          <span className='rounded-md bg-background/85 backdrop-blur-sm'>
            <Button
              inline={false}
              height={ControlsHeight.S}
              data-testid='change-cover'
              icon={icon16(ImageIcon)}
              onClick={() => setCover((c) => (c.includes('sc2-battle') ? assetUrl('starcraft/sc2-logo.webp') : assetUrl('starcraft/sc2-battle.webp')))}
            >
              更换封面
            </Button>
          </span>
        </span>

        {/* 身份卡：**从上到下的透明渐变**（用户 2026-10-13 定稿口径：
            「平均透明度 60% 透」= 卡片整高的**平均 alpha ≈ 0.4**；顶部最透、往下逐渐收紧、任何位置都不到实色；
            深浅色**共用这一套值**，不做 dark: 变体）。
            形状（0–35% 持平 0 → 65% 到 via → 100% 到 to）：
              from-background/0  from-35%  → 卡片的 0–35%（含头像带 7%–31%）**完全不遮挡**，壁纸原样透出来；
              via-background/70  via-65%  → 名字带（38%–48%）落在爬升段，中段值 0.70；
              to-background/95            → 统计行（78%–93%）落在接近实底的带上，但**不是实色**（0.95，不到 1.0）。
            平均 alpha 是这个形状算出来的，不是拍的：mean = 0.325·via + 0.175·to（前 35% 为 0、
            35–65% 线性爬升、65–100% 线性收口）→ 0.325×0.70 + 0.175×0.95 = **0.394**，落在用户要的 0.35–0.45。
            壁纸遮罩层（上面那一层）只在**底部 80%–100%** 收口（0 → 0.95），它的平均 alpha 只有 ~0.09，
            所以合成平均 ≈ **0.403**（两层相乘，合成值也算过）；底部收口的用处是让 hero 底边不出现硬边。
            **为什么「先持平再爬升」**：上一版是 from-background/10 → via-42%，0→42% 一直在爬，
            头像正好卡在爬升段中间（当时不透明度已 ~0.65），壁纸被冲淡成一层灰 —— 现在是 0–35% 恒为 0。
            **为什么整卡不再用 backdrop-blur**：原来是 backdrop-blur-lg（16px），把壁纸细节平均掉了，
            卡内只剩中性灰 —— 用户说「看不清背景」指的就是这个。模糊只留给真正需要的两处：
            右上「更换封面」按钮自带 backdrop-blur-sm 底、右侧「关注 / 发私信」按钮组自带 bg-background/70 底。
            已知取舍（2026-10-13 如实记录）：浅色主题下名字/@handle/简介 这三行压在壁纸的暗部上，读起来偏弱
            （统计行、徽标、按钮都清楚）。在「平均 0.4 + 顶部全透 + 不到实色」三条约束下中段拿不到浅底，
            要更清楚只能抬平均、换封面素材，或给文字加局部底（用户已否决）。
            mb-2 而不是 mb-4：hero 还要装 144px 壁纸条，这 8px 是补给首屏预算的（见上面的警告，**不要改 padding/gap**）。 */}
        <div className='relative z-10 mx-4 -mt-20 mb-2 flex flex-col gap-5 rounded-xl border-x border-b border-border bg-gradient-to-b from-background/0 from-35% via-background/70 via-65% to-background/95 p-5'>
          <div className='flex flex-wrap items-end gap-4'>
            {/* 头像外圈原来用实色 ring-background：在渐变里它是一枚不透明的白/黑环，
                和身后 50% 的渐变一比就像贴上去的圆片。改成 /60 让环与身后的底同一档透明度，
                仍然能分出头像与壁纸，但不突兀。 */}
            {/* 头像 = 上传入口（本人态）：点了进设置标签的头像项，那里有上传/更换/移除与体积提示。
                为什么不做成「点头像直接开文件框」：那需要把上传器提到 hero 里或再造一个隐藏输入框，
                和「更换封面」那颗按钮的位置关系也说不清；设计稿里跳一步比多一套控件划算。 */}
            <span className='rounded-full ring-4 ring-background/60'>
              {selfView.isSelf ? (
                <span className='relative block'>
                  <UserAvatar name='示范管理员' src={avatar ?? assetUrl('miyin/smile-160.webp')} size='xl' />
                  {/* 头像角上的小按钮才是上传入口（本人态才画）：点了切到「设置」标签并就地打开文件框。
                      看别人主页时这颗按钮不渲染，也没有「设置」标签 —— 一行都不出现。 */}
                  <span className='absolute -right-1 -bottom-1 rounded-full bg-background'>
                    <Button
                      inline={false}
                      height={ControlsHeight.S}
                      icon={icon16(ImagePlus)}
                      aria-label='更换头像'
                      data-testid='avatar-upload-entry'
                      onClick={pickAvatar}
                    />
                  </span>
                </span>
              ) : (
                <UserAvatar name='示范管理员' src={assetUrl('miyin/smile-160.webp')} size='xl' />
              )}
            </span>
          </div>
          <div className='flex flex-col gap-2'>
            <span className='flex flex-wrap items-center gap-2'>
              <Username nickname='示范管理员' size='xl' strong />
              <RoleBadge role={{ key: 'admin', name: '管理员' }} />
              <TitleBadge title={{ name: '执政官', color: '#2563eb' }} />
            </span>
            <span className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground'>
              <span>@demo-admin</span>
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
          <div className='flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-t border-border pt-4'>
            <span className='flex flex-wrap items-center gap-8'>
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
            </span>
            {/* 动作组挂在**卡片右下角**（落在统计行右侧，所以卡片不会变高；窄屏时它换行到统计行下方）。
                为什么不再要那层自保的底：上一版它压在头像右侧的壁纸上（那一带渐变 alpha=0），所以自带 bg-background/70；
                现在它落在卡片底部 —— 那里渐变的 alpha 已经 0.95（近乎实底），底是现成的，再加一层只是多一个方块。
                为什么用 ghost：Ring 默认态自带一圈描边，两个带框按钮并排挂在右下角，看着像两个「控件盒」；
                ghost 去掉描边，读起来是「一对轻动作」。关注保留 primary（这一组唯一的实心动作，填充色见下），
                height 用 S：这一行的高度由 20px 的统计数字决定，默认高度的按钮会把整行顶高几像素，
                而 hero 高度是首屏预算（见上方警告）。 */}
            <span className='flex flex-nowrap items-center gap-1'>
              {/* 关注保持 primary（这一组里的主动作），发私信/更多用 ghost（去掉 Ring 默认态自带的描边）；
                  **三颗都必须 inline={false}** —— 这是踩过第四次的那个坑：
                    Ring 的 isInline = inline ?? text ?? !!icon，只要传了 icon 又没显式给 inline，
                    按钮就落到 .ring-button-inline（display:inline、padding:0、color:link），
                    于是 primary 也不填充、看起来像一行蓝字。
                  实测（2026-10-13，同一套像素扫描）：inline 时饱和蓝像素 135 个、最长连续横向 run 12px（只有字形）；
                  加 inline={false} 后 1626 个、最长 run 76px，bbox 76×23 = 一颗真正的填充按钮。
                  （先前"Ring primary 没定义背景变量"的判断是错的，已撤回：填充一直是好的，是 inline 把它压掉了。） */}
              <Button primary inline={false} height={ControlsHeight.S} icon={icon16(UserPlus)}>关注</Button>
              <Button ghost inline={false} height={ControlsHeight.S} icon={icon16(MessageSquare)}>发私信</Button>
              <Button ghost inline={false} height={ControlsHeight.S} icon={icon16(MoreHorizontal)} aria-label='更多操作' />
            </span>
          </div>
        </div>
      </section>

      <IconTabs items={tabs} value={activeTab} onChange={setTab} ariaLabel='个人主页分区' />

      <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]'>
        <div className='flex flex-col gap-4'>
          {activeTab === 'posts' ? (
            <Island withoutPaddings>
              {TOPICS.map((t) => (
                <TopicRow key={t.id} topic={t} />
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
          <SponsorCard isSelf={selfView.isSelf} channels={selfView.channels} />
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