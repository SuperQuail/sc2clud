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

// DevRoom 00 · 样板间：**宣传页**（landing page）
// 它不是站内真页面，而是**美术风格基准**：配色、字号音阶、间距、控件长相，看这一页定调。
// 排版数值来自公开的内容站设计规范：大标题行高 1.0 / 字距 -0.03em；正文 18px / 1.6；
// 音阶 1.333（18 → 24 → 32 → 42）；正文行宽 ≤65ch；展示型页面克制用动效。
// 控件一览用的全是已登记件——它们就是全站的基础。

const FEATURES = [
  { Icon: Compass, title: '分区清晰', text: '自制战役、对战、工具各自独立，进来就知道该去哪。' },
  { Icon: PenLine, title: '发帖顺手', text: 'Markdown 所见即所得，插入图片自动压缩，提及直接 @ 人名。' },
  { Icon: ShieldCheck, title: '权限可查', text: '每个人的权限与头衔公开可查，谁能做什么一目了然。' },
];

const SCALE = [
  { size: '42px', role: '页面主标题', cls: 'text-[42px] leading-[1.05] tracking-[-0.03em] font-semibold' },
  { size: '32px', role: '区块标题', cls: 'text-[32px] leading-[1.15] tracking-[-0.02em] font-semibold' },
  { size: '24px', role: '小节标题', cls: 'text-[24px] leading-[1.2] font-semibold' },
  { size: '18px', role: '正文', cls: 'text-[18px] leading-[1.6]' },
  { size: '13px', role: '次要信息', cls: 'text-[13px] leading-[1.5] text-muted-foreground' },
];

const SWATCHES = [
  { name: 'primary', cls: 'bg-primary' },
  { name: 'accent', cls: 'bg-accent' },
  { name: 'muted', cls: 'bg-muted' },
  { name: 'border', cls: 'bg-border' },
  { name: 'destructive', cls: 'bg-destructive' },
  { name: 'mention', cls: 'bg-[var(--mention-color)]' },
];

export default function ShowroomPage() {
  return (
    <div className='flex flex-col gap-16 pb-10'>
      {/* ── 首屏 ── */}
      <section className='flex flex-col items-center gap-6 pt-10 text-center'>
        <img src={assetUrl('starcraft/sc2-logo.webp')} alt='' className='h-10 w-auto' />
        <span className='flex items-center gap-2 rounded-full border border-border px-3 py-1 text-[13px] text-muted-foreground'>
          <Sparkles aria-hidden className='size-3.5' />
          第三章「余烬」已发布
        </span>
        <h1 className='max-w-[24ch] text-[42px] leading-[1.05] font-semibold tracking-[-0.03em] text-foreground'>
          星际争霸战役作者的社区
        </h1>
        <p className='max-w-[65ch] text-[18px] leading-[1.6] text-muted-foreground'>
          发布你的战役、找人来测试、把踩过的坑写下来。这里没有水贴，只有一张张地图和一群正在做东西的人。
        </p>
        <span className='flex flex-wrap items-center justify-center gap-3'>
          <Button primary href={appPath('b/campaign')}>浏览分区</Button>
          <Button href={appPath('b/campaign/new')}>发布战役</Button>
        </span>
        <span className='flex items-center gap-3 text-[13px] text-muted-foreground'>
          <AvatarStack size={24}>
            <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='sm' />
            <UserAvatar name='林诗' src={assetUrl('miyin-chibi-160.webp')} size='sm' />
            <UserAvatar name='某小X' size='sm' />
          </AvatarStack>
          已有 42 位作者发布了 168 张地图
        </span>
        <img
          src={assetUrl('starcraft/sc2-battle.webp')}
          alt='战役场景预览'
          className='mt-4 w-full max-w-[56rem] rounded-xl border border-border shadow-sm'
        />
      </section>

      {/* ── 三个卖点 ── */}
      <section className='flex flex-col gap-6'>
        <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>为什么在这里发</h2>
        <div className='grid gap-4 md:grid-cols-3'>
          {FEATURES.map(({ Icon, title, text }) => (
            <Island key={title} withoutPaddings>
              <div className='flex flex-col gap-3 p-5'>
                <Icon aria-hidden className='size-5 text-primary' />
                <span className='text-[16px] font-semibold text-foreground'>{title}</span>
                <span className='text-[15px] leading-[1.6] text-muted-foreground'>{text}</span>
              </div>
            </Island>
          ))}
        </div>
      </section>

      {/* ── 控件一览：全站的基础件 ── */}
      <section className='flex flex-col gap-6'>
        <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>界面基础</h2>
        <p className='max-w-[65ch] text-[16px] leading-[1.6] text-muted-foreground'>
          下面这些是全站控件长相的基准——按钮、徽标、输入、开关、分页。新页面照它们拼，不要另发明样式。
        </p>
        <Island withoutPaddings>
          <div className='grid gap-6 p-6 md:grid-cols-2'>
            <div className='flex flex-col gap-3'>
              <span className='text-[13px] font-medium tracking-wide text-muted-foreground'>按钮</span>
              <span className='flex flex-wrap items-center gap-2'>
                <Button primary icon={icon16(PenLine)}>发帖</Button>
                <Button>收藏</Button>
                <Button disabled>不可用</Button>
              </span>
            </div>
            <div className='flex flex-col gap-3'>
              <span className='text-[13px] font-medium tracking-wide text-muted-foreground'>标签</span>
              <span className='flex flex-wrap items-center gap-2'>
                <Tag tagType={TagType.MAIN}>公告</Tag>
                <Tag tagType={TagType.SUCCESS}>资源</Tag>
                <Tag tagType={TagType.WARNING}>求助</Tag>
                <Tag tagType={TagType.PURPLE}>讨论</Tag>
              </span>
            </div>
            <div className='flex flex-col gap-3'>
              <span className='text-[13px] font-medium tracking-wide text-muted-foreground'>身份</span>
              <span className='flex flex-wrap items-center gap-3'>
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
              <span className='text-[13px] font-medium tracking-wide text-muted-foreground'>表单</span>
              <span className='flex flex-wrap items-center gap-3'>
                <Input placeholder='搜索主题、作者…' aria-label='搜索主题、作者' name='q' autoComplete='off' />
                <Toggle checked onChange={() => {}}>仅看未回复</Toggle>
              </span>
            </div>
            <div className='flex flex-col gap-3 md:col-span-2'>
              <span className='text-[13px] font-medium tracking-wide text-muted-foreground'>分页</span>
              <AppPager total={1284} currentPage={1} pageSize={20} onPageChange={() => {}} onPageSizeChange={() => {}} />
            </div>
          </div>
        </Island>
      </section>

      {/* ── 字号与配色基准 ── */}
      <section className='grid gap-6 lg:grid-cols-2'>
        <div className='flex flex-col gap-4'>
          <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>字号音阶</h2>
          <p className='max-w-[65ch] text-[16px] leading-[1.6] text-muted-foreground'>
            按 1.333 递进（1.333 音阶）：主标题到正文只有四级，不要再用别的字号。
          </p>
          <div className='flex flex-col gap-3'>
            {SCALE.map((s) => (
              <span key={s.size} className='flex items-baseline gap-4'>
                <span className='w-14 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground'>{s.size}</span>
                <span className={s.cls + ' text-foreground'}>{s.role}</span>
              </span>
            ))}
          </div>
        </div>
        <div className='flex flex-col gap-4'>
          <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>颜色</h2>
          <p className='max-w-[65ch] text-[16px] leading-[1.6] text-muted-foreground'>
            颜色只从令牌取，不许在组件里写死。下面这几个是常用的语义色。
          </p>
          <div className='grid grid-cols-3 gap-3'>
            {SWATCHES.map((sw) => (
              <span key={sw.name} className='flex flex-col gap-2'>
                <span className={'h-12 rounded-md border border-border ' + sw.cls} />
                <span className='text-[12px] text-muted-foreground'>{sw.name}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── 结尾行动 ── */}
      <section className='flex flex-col items-center gap-4 rounded-xl border border-border bg-muted/40 px-6 py-10 text-center'>
        <Users aria-hidden className='size-5 text-primary' />
        <h2 className='text-[24px] leading-[1.2] font-semibold text-foreground'>你的战役，值得被人玩到</h2>
        <p className='max-w-[65ch] text-[16px] leading-[1.6] text-muted-foreground'>
          注册只要一个昵称，发帖不用等审核。先把地图传上来，剩下的交给评论区。
        </p>
        <Button primary href={appPath('signup')}>开始使用</Button>
      </section>
    </div>
  );
}
