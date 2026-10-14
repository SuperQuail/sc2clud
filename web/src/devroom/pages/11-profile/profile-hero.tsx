import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ImagePlus, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge, type UserRole } from '@/ui/user/role-badge';
import { TitleBadge, type UserTitle } from '@/ui/user/title-badge';

// DevRoom 11 · 个人主页的 **hero**（壁纸带 + 压在下边缘的身份卡）。
// 从 index.tsx 拆出来，理由与 11 页里的 sponsor-card 同一条：这一块自成一体、只通过 props 与页面交互，
// 而且**产品路由要原样复用它**（上线设计 P2 决策 2：产品页与房间共用同一份实现，不是抄一份）。
//
// 那几段长注释（透明度定稿 0.394 / 为什么是 flow-root + isolate / 首屏预算 / inline 第五次咬人）
// 留在 index.tsx 会更难找，所以跟着这一块一起搬过来 —— 注释与它解释的那几行必须在一起。
export type ProfileStat = { value: string; label: string };

export type ProfileHeroProps = {
  /** 壁纸。真实站点暂时没有用户封面端点，产品路由传一张默认素材 */
  cover: string;
  nickname: string;
  handle: string;
  /** 已经格式化好的一句话（「2024 年 3 月加入」）；不传就整段不显示 */
  joined?: string;
  /** 地区：接口没有这个字段，产品路由不传 */
  location?: string;
  bio?: string;
  avatar?: string | null;
  role?: UserRole | null;
  title?: UserTitle | null;
  stats?: ProfileStat[];
  /** 顶栏右上角那一对动作（更换封面 / 更换头像）。真实站点没有上传端点时调用方可以不画 */
  topActions?: ReactNode;
  /** 封面当前是不是一张图（true = 画「更换封面」，false = 画「加个封面」）。 */
  hasCover?: boolean;
  /**
   * 「更换封面」点了之后干什么。**不传就不画那颗按钮** ——
   * 画一颗点了没反应的假入口比缺一个入口更糟（这正是用户报的「设置背景功能消失」的形态）。
   * 传了 null 则画一颗**明确禁用**的（例：看别人的主页时，那个动作对你毫无意义）：
   * 禁用 + title 说清原因，读的人不会以为它坏了。
   * 真站的落点：弹层里的真上传控件（POST/DELETE /me/cover，见 profile.tsx）。
   */
  onCoverPick?: (() => void) | null;
  /** 头像右下角的上传入口（它只是「去设置里换头像」的落点）。**不传就不画** —— 产品路由还没有上传端点 */
  onAvatarPick?: () => void;
  /** 卡片右下角的动作组（关注 / 发私信 / 更多）—— 真实站点只放真能用的那几个 */
  actions?: ReactNode;
};

export function ProfileHero({
  cover,
  nickname,
  handle,
  joined,
  location,
  bio,
  avatar,
  role,
  title,
  stats = [],
  topActions,
  hasCover = false,
  onCoverPick,
  onAvatarPick,
  actions,
}: ProfileHeroProps) {
  return (
    // ⚠️ 首屏预算：这一页的 hero 高度决定右栏第一格（赞助入口）能不能落在 1440x900 内。
    //    来历：hero 每长高一点，赞助入口就往下走；它曾掉出过首屏（用户报「主页没有赞助按钮」）。
    //    **现在唯一的旋钮是下面那个 h-36 占位条**（= 身份卡上方可见的壁纸条高度）——
    //    改它 / 往 hero 加内容 / 换更高的封面 / 调大字号，都要重新量一次按钮 bottom 是否仍 <= 900
    //    （用 CDP 量，不要目测）。
    //    **注意真实壳的页头高度与 DevRoom 不同，所以「当前值」不要写进注释——写「怎么量」，不写「量到多少」。**
    //
    // isolate：建独立层叠上下文，壁纸两层的 -z-10 才落在「section 背景之上、内容之下」，
    // 否则 -z-10 跑到 section 背景后面，壁纸直接看不见（踩过）。
    // flow-root：**壁纸改成绝对定位之后，身份卡的 -mt-20 会向上穿透 section**（没有块级内容挡着就会发生
    // margin collapse），整个 section 被顶高 80px、头像行被 overflow-hidden 裁掉（踩过）。
    // flow-root 建立 BFC 挡住这次外边距合并。
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
      {(topActions || onCoverPick !== undefined) ? (
        <span className='absolute right-3 top-3 z-20 flex items-center gap-2'>
          {/* 「更换封面」由 **hero 自己**画（不走 topActions）：调用方只要给一个 onCoverPick，
              就不会再出现「调用方忘了画这颗按钮 → 入口凭空消失」那种形态。
              底用卡片色 + 轻微模糊把按钮托离壁纸（浅色壁纸上深蓝字看不清）。 */}
          {onCoverPick !== undefined ? (
            <span className='rounded-md bg-background/85 backdrop-blur-sm'>
              <Button
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(ImagePlus)}
                data-testid='change-cover'
                disabled={onCoverPick === null}
                title={onCoverPick === null ? '这是别人的主页，封面只有本人能换' : undefined}
                onClick={onCoverPick ?? undefined}
              >
                {hasCover ? '更换封面' : '加个封面'}
              </Button>
            </span>
          ) : null}
          {topActions}
        </span>
      ) : null}

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
            {onAvatarPick ? (
              <span className='relative block'>
                <UserAvatar name={nickname} src={avatar} size='xl' />
                {/* 头像角上的小按钮才是上传入口（本人态才画）：点了切到「设置」标签并就地打开文件框。
                    看别人主页时这颗按钮不渲染，也没有「设置」标签 —— 一行都不出现。 */}
                <span className='absolute -right-1 -bottom-1 rounded-full bg-background'>
                  <Button
                    inline={false}
                    height={ControlsHeight.S}
                    icon={icon16(ImagePlus)}
                    aria-label='更换头像'
                    data-testid='avatar-upload-entry'
                    onClick={onAvatarPick}
                  />
                </span>
              </span>
            ) : (
              <UserAvatar name={nickname} src={avatar} size='xl' />
            )}
          </span>
        </div>

        <div className='flex flex-col gap-2'>
          <span className='flex flex-wrap items-center gap-2'>
            <Username nickname={nickname} size='xl' strong />
            {role ? <RoleBadge role={role} /> : null}
            {title ? <TitleBadge title={title} /> : null}
          </span>
          <span className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground'>
            <span>@{handle}</span>
            {joined ? <span>· {joined}</span> : null}
            {location ? (
              <span className='flex items-center gap-1'>
                <MapPin aria-hidden className='size-3.5' />
                {location}
              </span>
            ) : null}
          </span>
          {bio ? <p className='m-0 max-w-[65ch] text-[15px] leading-[1.6] text-muted-foreground'>{bio}</p> : null}
        </div>

        <div className='flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-t border-border pt-4'>
          <span className='flex flex-wrap items-center gap-8'>
            {stats.map((st) => (
              <span key={st.label} className='flex items-baseline gap-1.5'>
                <span className='text-[20px] leading-none font-semibold tabular-nums text-foreground'>{st.value}</span>
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
              而 hero 高度是首屏预算（见上方警告）。
              **每颗都必须 inline={false}** —— 这是踩过第四次/第五次的那个坑：
                Ring 的 isInline = inline ?? text ?? !!icon，只要传了 icon 又没显式给 inline，
                按钮就落到 .ring-button-inline（display:inline、padding:0、color:link），
                于是 primary 也不填充、看起来像一行蓝字。
              实测（2026-10-13，同一套像素扫描）：inline 时饱和蓝像素 135 个、最长连续横向 run 12px（只有字形）；
              加 inline={false} 后 1626 个、最长 run 76px，bbox 76×23 = 一颗真正的填充按钮。
              （先前"Ring primary 没定义背景变量"的判断是错的，已撤回：填充一直是好的，是 inline 把它压掉了。） */}
          <span className='flex flex-nowrap items-center gap-1'>{actions}</span>
        </div>
      </div>
    </section>
  );
}
