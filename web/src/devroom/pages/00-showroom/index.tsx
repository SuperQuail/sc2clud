import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import AvatarStack from '@jetbrains/ring-ui-built/components/avatar-stack/avatar-stack';
import { Compass, PenLine, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { appPath, assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { UserAvatar } from '@/ui/user/avatar';
import { AppPager } from '@/ui/pager';

// DevRoom 00 · 样板间：**宣传页**（landing page），不是站内功能页。
// 它是**美术风格基准**：配色、字号音阶、层次与光影，看这一页定调。
// 排版数值来自公开的内容站规范：大标题 42px / 行高 1.05 / 字距 -0.03em；正文 18px / 1.6；
// 音阶 1.333（18 → 24 → 32 → 42）；正文行宽 ≤65ch；内容页克制用动效。
// 所有颜色都从令牌取（bg-primary/10 这类透明度写法也走令牌），不写死色值。

const FEATURES = [
  { Icon: Compass, title: '分区清晰', text: '自制战役、对战、工具各自独立，进来就知道该去哪。' },
  { Icon: PenLine, title: '发帖顺手', text: 'Markdown 所见即所得，插入图片自动压缩，提及直接 @ 人名。' },
  { Icon: ShieldCheck, title: '权限可查', text: '每个人的权限与头衔公开可查，谁能做什么一目了然。' },
];

const STATS = [
  { n: '168', unit: '张', label: '已发布地图' },
  { n: '42', unit: '位', label: '活跃作者' },
  { n: '12.4', unit: 'k', label: '累计回复' },
  { n: '236', unit: '次', label: '今日浏览' },
];

const SCALE = [
  { size: '42px', role: '页面主标题', cls: 'text-[42px] leading-[1.05] tracking-[-0.03em] font-semibold' },
  { size: '32px', role: '区块标题', cls: 'text-[32px] leading-[1.15] tracking-[-0.02em] font-semibold' },
  { size: '24px', role: '小节标题', cls: 'text-[24px] leading-[1.2] font-semibold' },
  { size: '18px', role: '正文', cls: 'text-[18px] leading-[1.6]' },
  { size: '13px', role: '次要信息', cls: 'text-[13px] leading-[1.5] text-muted-foreground' },
];

const SWATCHES = [
  { name: 'primary', cls: 'bg-primary', use: '主操作' },
  { name: 'accent', cls: 'bg-accent', use: '悬停/选中' },
  { name: 'muted', cls: 'bg-muted', use: '次级底' },
  { name: 'border', cls: 'bg-border', use: '描边' },
  { name: 'destructive', cls: 'bg-destructive', use: '危险' },
  { name: 'mention', cls: 'bg-[var(--mention-color)]', use: '@提及' },
];

export default function ShowroomPage() {
  return (
    <div className='flex flex-col gap-20 pb-12'>
      {/* ── 首屏：顶部一层主色柔光，把注意力收到标题上 ── */}
      <section className='relative flex flex-col items-center gap-6 pt-14 text-center'>
        <span aria-hidden className='pointer-events-none absolute -top-24 left-1/2 h-72 w-[46rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl' />
        <img src={assetUrl('starcraft/sc2-logo.webp')} alt='' className='relative h-10 w-auto' />
        <span className='relative flex items-center gap-2 rounded-full border border-primary/30 bg-primary/8 px-3 py-1 text-[13px] text-primary'>
          <Sparkles aria-hidden className='size-3.5' />
          第三章「余烬」已发布
        </span>
        <h1 className='relative max-w-[22ch] text-balance text-[42px] leading-[1.05] font-semibold tracking-[-0.03em] text-foreground'>
          星际争霸战役作者的社区
        </h1>
        <p className='relative max-w-[65ch] text-pretty text-[18px] leading-[1.6] text-muted-foreground'>
          发布你的战役、找人来测试、把踩过的坑写下来。这里没有水贴，只有一张张地图和一群正在做东西的人。
        </p>
        <span className='relative flex flex-wrap items-center justify-center gap-3'>
          <Button primary href={appPath('b/campaign')}>浏览分区</Button>
          <Button href={appPath('b/campaign/new')}>发布战役</Button>
        </span>
        <span className='relative flex items-center gap-3 text-[13px] text-muted-foreground'>
          <AvatarStack size={24}>
            <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='sm' />
            <UserAvatar name='林诗' src={assetUrl('miyin-chibi-160.webp')} size='sm' />
            <UserAvatar name='某小X' size='sm' />
          </AvatarStack>
          已有 42 位作者发布了 168 张地图
        </span>
        {/* 主视觉：外面套一层柔光，让它像「浮」在页面上而不是贴上去 */}
        <span className='relative mt-6 block w-full max-w-[56rem]'>
          <span aria-hidden className='absolute inset-x-10 -bottom-4 h-24 rounded-full bg-primary/15 blur-3xl' />
          <img
            src={assetUrl('starcraft/sc2-battle.webp')}
            alt='战役场景预览'
            className='relative w-full rounded-2xl border border-border ring-1 ring-foreground/5'
          />
        </span>
      </section>

      {/* ── 数据带：给页面一个节奏停顿 ── */}
      <section className='grid grid-cols-2 gap-4 rounded-2xl border border-border bg-muted/40 px-8 py-7 md:grid-cols-4'>
        {STATS.map((s) => (
          <span key={s.label} className='flex flex-col items-center gap-1 text-center'>
            <span className='text-[32px] leading-none font-semibold tracking-[-0.02em] text-foreground tabular-nums'>
              {s.n}
              <span className='ml-0.5 text-[18px] font-medium text-muted-foreground'>{s.unit}</span>
            </span>
            <span className='text-[13px] text-muted-foreground'>{s.label}</span>
          </span>
        ))}
      </section>

      {/* ── 三个卖点：图标做色块底，卡片有悬停反馈 ── */}
      <section className='flex flex-col gap-6'>
        <span className='flex flex-col gap-2'>
          <span className='text-[13px] font-medium tracking-[0.08em] text-primary uppercase'>Features</span>
          <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>为什么在这里发</h2>
        </span>
        <div className='grid gap-4 md:grid-cols-3'>
          {FEATURES.map(({ Icon, title, text }) => (
            <Island key={title} withoutPaddings>
              <div className='flex h-full flex-col gap-4 rounded-[inherit] p-6 transition-shadow hover:shadow-md'>
                <span className='flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary'>
                  <Icon aria-hidden className='size-5' />
                </span>
                <span className='text-[18px] leading-[1.3] font-semibold text-foreground'>{title}</span>
                <span className='text-[15px] leading-[1.6] text-muted-foreground'>{text}</span>
              </div>
            </Island>
          ))}
        </div>
      </section>

      {/* ── 控件一览 ── */}
      <section className='flex flex-col gap-6'>
        <span className='flex flex-col gap-2'>
          <span className='text-[13px] font-medium tracking-[0.08em] text-primary uppercase'>Components</span>
          <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>界面基础</h2>
          <p className='max-w-[65ch] text-[16px] leading-[1.6] text-muted-foreground'>
            全站控件长相的基准——按钮、徽标、输入、开关、分页。新页面照它们拼，不要另发明样式。
          </p>
        </span>
        <Island withoutPaddings>
          <div className='grid gap-8 p-7 md:grid-cols-2'>
            <div className='flex flex-col gap-3'>
              <span className='text-[12px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>按钮</span>
              <span className='flex flex-wrap items-center gap-2'>
                <Button primary icon={icon16(PenLine)}>发帖</Button>
                <Button>收藏</Button>
                <Button disabled>不可用</Button>
              </span>
            </div>
            <div className='flex flex-col gap-3'>
              <span className='text-[12px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>标签</span>
              <span className='flex flex-wrap items-center gap-2'>
                <Tag tagType={TagType.MAIN}>公告</Tag>
                <Tag tagType={TagType.SUCCESS}>资源</Tag>
                <Tag tagType={TagType.WARNING}>求助</Tag>
                <Tag tagType={TagType.PURPLE}>讨论</Tag>
              </span>
            </div>
            <div className='flex flex-col gap-3'>
              <span className='text-[12px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>身份</span>
              <span className='flex flex-wrap items-center gap-4'>
                <span className='flex items-center gap-2'>
                  <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='sm' />
                  <Username nickname='唐天' role={{ key: 'admin', name: '管理员' }} badge='corner' />
                  <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='sm' />
                </span>
                <span className='flex items-center gap-2'>
                  <UserAvatar name='林诗' size='sm' />
                  <Username nickname='林诗' />
                  <RoleBadge role={{ key: 'creator', name: '认证创作者' }} />
                </span>
              </span>
            </div>
            <div className='flex flex-col gap-3'>
              <span className='text-[12px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>表单</span>
              <span className='flex flex-wrap items-center gap-3'>
                <Input placeholder='搜索主题、作者…' aria-label='搜索主题、作者' name='q' autoComplete='off' />
                <Toggle checked onChange={() => {}}>仅看未回复</Toggle>
              </span>
            </div>
            <div className='flex flex-col gap-3 md:col-span-2'>
              <span className='text-[12px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>分页</span>
              <AppPager total={1284} currentPage={1} pageSize={20} onPageChange={() => {}} onPageSizeChange={() => {}} />
            </div>
          </div>
        </Island>
      </section>

      {/* ── 字号与配色基准 ── */}
      <section className='flex flex-col gap-6'>
        <span className='flex flex-col gap-2'>
          <span className='text-[13px] font-medium tracking-[0.08em] text-primary uppercase'>Foundations</span>
          <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>字号与颜色</h2>
        </span>
        <div className='grid gap-6 lg:grid-cols-2'>
          <Island withoutPaddings>
            <div className='flex flex-col gap-5 p-7'>
              <span className='text-[12px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>1.333 音阶</span>
              {SCALE.map((s) => (
                <span key={s.size} className='flex items-baseline gap-4 border-b border-border pb-3 last:border-b-0 last:pb-0'>
                  <span className='w-14 shrink-0 rounded-md bg-muted px-2 py-0.5 text-right text-[12px] tabular-nums text-muted-foreground'>
                    {s.size}
                  </span>
                  <span className={s.cls + ' text-foreground'}>{s.role}</span>
                </span>
              ))}
            </div>
          </Island>
          <Island withoutPaddings>
            <div className='flex flex-col gap-5 p-7'>
              <span className='text-[12px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>语义色（全部来自令牌）</span>
              <div className='grid grid-cols-3 gap-4'>
                {SWATCHES.map((sw) => (
                  <span key={sw.name} className='flex flex-col gap-2'>
                    <span className={'h-14 rounded-xl ring-1 ring-foreground/5 transition-transform hover:scale-[1.03] ' + sw.cls} />
                    <span className='flex flex-col'>
                      <span className='text-[12px] font-medium text-foreground'>{sw.name}</span>
                      <span className='text-[12px] text-muted-foreground'>{sw.use}</span>
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </Island>
        </div>
      </section>

      {/* ── 结尾行动：主色淡底，把视线收住 ── */}
      <section className='relative flex flex-col items-center gap-4 overflow-hidden rounded-2xl border border-primary/20 bg-primary/8 px-6 py-12 text-center'>
        <span aria-hidden className='pointer-events-none absolute -bottom-16 left-1/2 h-40 w-[36rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl' />
        <Users aria-hidden className='relative size-6 text-primary' />
        <h2 className='relative text-[24px] leading-[1.2] font-semibold text-foreground'>你的战役，值得被人玩到</h2>
        <p className='relative max-w-[65ch] text-[16px] leading-[1.6] text-muted-foreground'>
          注册只要一个昵称，发帖不用等审核。先把地图传上来，剩下的交给评论区。
        </p>
        <span className='relative'><Button primary href={appPath('signup')}>开始使用</Button></span>
      </section>

      <footer className='flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-[13px] text-muted-foreground'>
        <span>明明咕咕 · 星际争霸战役社区</span>
        <span className='flex flex-wrap items-center gap-4'>
          <a href={appPath('about')} className='rounded-[3px] outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'>关于</a>
          <a href={appPath('rules')} className='rounded-[3px] outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'>版规</a>
          <a href={appPath('contact')} className='rounded-[3px] outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'>联系</a>
        </span>
      </footer>
    </div>
  );
}
