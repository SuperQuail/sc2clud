import { Heart, MessageCircle, Plus, Share2, ThumbsUp } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { UserBadge, type UserSummary } from '@/ui/user/user-badge';
import { VividButton } from '@/ui/vivid/button';

// DevRoom 06 · 用户向风格候选
// 同一份内容、四套排版与配色。**四种都必须支持夜间模式**：表面与文字一律走令牌（bg-card / text-foreground /
// text-muted-foreground / bg-muted / border-border），需要偏离的地方用 dark: 变体（已接到 data-theme）。
// 只有风格 2 是「无论昼夜都深色」——那是它的身份，属于设计选择而不是漏了夜间模式。
const AUTHOR: UserSummary = {
  handle: 'tangtian',
  nickname: '唐天',
  avatar: assetUrl('miyin-portrait-320.webp'),
  role: { key: 'moderator', name: '版主' },
  title: { name: '执政官', color: '#2563eb' },
};
const REPLIER: UserSummary = { handle: 'linshi', nickname: '林诗', avatar: assetUrl('miyin-chibi-160.webp') };
const COVER = assetUrl('starcraft/sc2-battle.webp');

const POST = {
  board: '自制战役',
  intro: '和大家一起做地图、写脚本的地方',
  title: '《星海余烬》第三章发布：18 张地图，三个结局',
  excerpt: '主线六张、支线十二张，配音和过场都补齐了。存档兼容上一版，装过第二章的直接进游戏就行。',
  replies: 326,
  likes: 148,
};
const LIST = [
  { title: '触发器模板库 v2：37 个拖进地图就能用的模块', who: REPLIER, when: '1 小时前', replies: 88 },
  { title: '战役地图亮度与雾效预设包（11 个预设）', who: AUTHOR, when: '3 小时前', replies: 57 },
  { title: '一人做战役的排期经验：美术外包和脚本怎么拆', who: AUTHOR, when: '5 小时前', replies: 71 },
];

function Frame({ name, tagline, children }: { name: string; tagline: string; children: React.ReactNode }) {
  return (
    <section className='overflow-hidden rounded-xl border border-border'>
      <header className='flex flex-wrap items-baseline gap-3 bg-muted px-4 py-2.5'>
        <h2 className='text-[13px] font-semibold text-foreground'>{name}</h2>
        <p className='text-[12px] text-muted-foreground'>{tagline}</p>
      </header>
      <div className='bg-background p-4'>{children}</div>
    </section>
  );
}

export default function UserStylesPage() {
  return (
    <div className='flex flex-col gap-5'>
      <Frame name='风格 1 · 明快圆润' tagline='大字号、大圆角、饱和主色，最像主流社区 App'>
        <div className='flex flex-col gap-4 rounded-3xl bg-card p-6 text-foreground ring-1 ring-border'>
          <div className='flex items-start justify-between gap-4'>
            <div>
              <h3 className='text-3xl font-extrabold tracking-tight'>{POST.board}</h3>
              <p className='mt-1 text-base leading-relaxed text-muted-foreground'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus} className='shadow-lg shadow-primary/25'>发帖</VividButton>
          </div>
          <article className='flex gap-4 rounded-3xl bg-muted p-4'>
            <img src={COVER} alt='' width={200} height={120} className='h-28 w-48 shrink-0 rounded-2xl object-cover' />
            <div className='flex min-w-0 flex-col gap-2'>
              <h4 className='text-xl font-bold leading-snug'>{POST.title}</h4>
              <p className='line-clamp-2 text-[15px] leading-relaxed text-muted-foreground'>{POST.excerpt}</p>
              <div className='flex items-center gap-4 text-sm text-muted-foreground'>
                <UserBadge user={AUTHOR} size='sm' />
                <span className='flex items-center gap-1.5'><MessageCircle className='size-4' />{POST.replies}</span>
                <span className='flex items-center gap-1.5'><ThumbsUp className='size-4' />{POST.likes}</span>
              </div>
            </div>
          </article>
          <div className='flex flex-wrap gap-3'>
            <VividButton tone='accent' size='lg' icon={Heart}>赞赏作者</VividButton>
            <VividButton tone='soft' size='lg'>收藏</VividButton>
            <VividButton tone='ghost' size='lg' icon={Share2}>分享</VividButton>
          </div>
        </div>
      </Frame>

      <Frame name='风格 2 · 深色电竞' tagline='无论昼夜都深色（这是它的身份）；高饱和渐变 + 描边发光'>
        <div className='flex flex-col gap-4 rounded-2xl bg-slate-950 p-6 text-slate-100'>
          <div className='flex items-start justify-between gap-4'>
            <div>
              <h3 className='bg-gradient-to-r from-cyan-300 to-blue-400 bg-clip-text text-3xl font-black tracking-tight text-transparent'>{POST.board}</h3>
              <p className='mt-1 text-base leading-relaxed text-slate-400'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus} className='bg-gradient-to-r from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/30'>发帖</VividButton>
          </div>
          <article className='flex gap-4 rounded-xl bg-slate-900 p-4 ring-1 ring-cyan-400/25'>
            <img src={COVER} alt='' width={200} height={120} className='h-28 w-48 shrink-0 rounded-lg object-cover opacity-90' />
            <div className='flex min-w-0 flex-col gap-2'>
              <span className='w-fit rounded bg-cyan-400/15 px-1.5 py-0.5 text-[11px] font-semibold tracking-widest text-cyan-300'>置顶</span>
              <h4 className='text-xl font-bold leading-snug text-white'>{POST.title}</h4>
              <p className='line-clamp-2 text-[15px] leading-relaxed text-slate-400'>{POST.excerpt}</p>
              <div className='flex items-center gap-4 text-sm text-slate-400'>
                <UserBadge user={AUTHOR} size='sm' />
                <span>{POST.replies} 回复</span>
                <span>{POST.likes} 赞</span>
              </div>
            </div>
          </article>
          <div className='flex flex-wrap gap-3'>
            <VividButton size='lg' icon={Heart} className='bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30'>赞赏作者</VividButton>
            <VividButton size='lg' className='bg-slate-800 text-slate-200 ring-1 ring-slate-700'>收藏</VividButton>
            <VividButton size='lg' className='bg-transparent text-slate-300 ring-1 ring-slate-700' icon={Share2}>分享</VividButton>
          </div>
        </div>
      </Frame>

      <Frame name='风格 3 · 清爽极简' tagline='细线、无阴影、大留白；靠字号与行高做层级'>
        <div className='flex flex-col gap-6 rounded-xl bg-card p-7 text-foreground ring-1 ring-border'>
          <div className='flex items-start justify-between gap-6'>
            <div>
              <h3 className='text-[28px] font-semibold tracking-tight'>{POST.board}</h3>
              <p className='mt-2 max-w-lg text-[15px] leading-7 text-muted-foreground'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus}>发帖</VividButton>
          </div>
          <div className='flex flex-col divide-y divide-border'>
            {LIST.map((t) => (
              <article key={t.title} className='flex items-start gap-4 py-5 first:pt-0 last:pb-0'>
                <img src={COVER} alt='' width={96} height={64} className='h-16 w-24 shrink-0 rounded-md object-cover' />
                <div className='flex min-w-0 flex-col gap-1.5'>
                  <h4 className='text-[17px] font-medium leading-7'>{t.title}</h4>
                  <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground'>
                    <UserBadge user={t.who} size='sm' />
                    <span>{t.replies} 条回复</span>
                    <span>{t.when}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </Frame>

      <Frame name='风格 4 · 暖色亲和' tagline='暖色强调 + 柔和阴影 + 更大字距，偏社区温度'>
        <div className='flex flex-col gap-4 rounded-2xl bg-card p-6 text-foreground ring-1 ring-[var(--vivid-accent)]/25'>
          <div className='flex items-start justify-between gap-4'>
            <div>
              <h3 className='text-3xl font-bold tracking-tight'>{POST.board}</h3>
              <p className='mt-1.5 text-base leading-relaxed text-muted-foreground'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus} className='bg-[var(--vivid-accent)] shadow-lg shadow-[var(--vivid-accent)]/25'>发帖</VividButton>
          </div>
          <article className='flex gap-4 rounded-2xl bg-muted p-4'>
            <img src={COVER} alt='' width={200} height={120} className='h-28 w-48 shrink-0 rounded-xl object-cover' />
            <div className='flex min-w-0 flex-col gap-2'>
              <h4 className='text-xl font-bold leading-relaxed'>{POST.title}</h4>
              <p className='line-clamp-2 text-[15px] leading-relaxed text-muted-foreground'>{POST.excerpt}</p>
              <div className='flex items-center gap-4 text-sm text-muted-foreground'>
                <UserBadge user={AUTHOR} size='sm' />
                <span>{POST.replies} 人回过</span>
                <span>{POST.likes} 人点赞</span>
              </div>
            </div>
          </article>
          <div className='flex flex-wrap gap-3'>
            <VividButton size='lg' icon={Heart} className='bg-[var(--vivid-accent)] shadow-lg shadow-[var(--vivid-accent)]/25'>赞赏作者</VividButton>
            <VividButton size='lg' className='bg-muted text-foreground ring-1 ring-border'>收藏</VividButton>
            <VividButton size='lg' className='bg-transparent text-muted-foreground' icon={Share2}>分享</VividButton>
          </div>
        </div>
      </Frame>
    </div>
  );
}
