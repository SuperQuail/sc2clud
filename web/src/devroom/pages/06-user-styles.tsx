import { Heart, MessageCircle, Plus, Share2, ThumbsUp } from 'lucide-react';
import { UserBadge, type UserSummary } from '@/ui/user/user-badge';
import { VividButton } from '@/ui/vivid/button';

// DevRoom 06 · 用户向风格候选
// 同一份内容（分区头 + 帖子卡 + 主题行），四套**排版与配色**。挑一个作为 B 系基线。
// 关注点全在「文字像不像给普通人看的」：字号、行高、字重、层级、圆角、阴影、留白。
const A = (p: string) => 'art/' + p;

const AUTHOR: UserSummary = {
  handle: 'tangtian',
  nickname: '唐天',
  avatar: A('miyin-portrait-320.webp'),
  role: { key: 'moderator', name: '版主' },
  title: { name: '执政官', color: '#2563eb' },
};
const REPLIER: UserSummary = { handle: 'linshi', nickname: '林诗', avatar: A('miyin-chibi-160.webp') };

// 内容用**人话**，不写参数名——预览要能看出文案气质
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
      <header className='flex flex-wrap items-baseline gap-3 bg-muted/60 px-4 py-2.5'>
        <h2 className='text-[13px] font-semibold text-foreground'>{name}</h2>
        <p className='text-[12px] text-muted-foreground'>{tagline}</p>
      </header>
      <div className='p-4'>{children}</div>
    </section>
  );
}

export default function UserStylesPage() {
  return (
    <div className='flex flex-col gap-5'>
      {/* 1 明快圆润 */}
      <Frame name='风格 1 · 明快圆润' tagline='大字号、大圆角、饱和度高的主色，最像主流社区 App'>
        <div className='flex flex-col gap-4 rounded-3xl bg-white p-6 text-slate-900'>
          <div className='flex items-start justify-between gap-4'>
            <div>
              <h3 className='text-3xl font-extrabold tracking-tight'>{POST.board}</h3>
              <p className='mt-1 text-base leading-relaxed text-slate-500'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus} className='shadow-lg shadow-blue-500/25'>发帖</VividButton>
          </div>
          <article className='flex gap-4 rounded-3xl bg-slate-50 p-4'>
            <img src={A('starcraft/sc2-battle.webp')} alt='' width={200} height={120} className='h-28 w-48 shrink-0 rounded-2xl object-cover' />
            <div className='flex min-w-0 flex-col gap-2'>
              <h4 className='text-xl font-bold leading-snug'>{POST.title}</h4>
              <p className='line-clamp-2 text-[15px] leading-relaxed text-slate-600'>{POST.excerpt}</p>
              <div className='flex items-center gap-4 text-sm text-slate-500'>
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

      {/* 2 深色电竞 */}
      <Frame name='风格 2 · 深色电竞' tagline='深底 + 高饱和渐变 + 描边发光，最贴「星际」的调性'>
        <div className='flex flex-col gap-4 rounded-2xl bg-slate-950 p-6 text-slate-100'>
          <div className='flex items-start justify-between gap-4'>
            <div>
              <h3 className='bg-gradient-to-r from-cyan-300 to-blue-400 bg-clip-text text-3xl font-black tracking-tight text-transparent'>
                {POST.board}
              </h3>
              <p className='mt-1 text-base leading-relaxed text-slate-400'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus} className='bg-gradient-to-r from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/30'>发帖</VividButton>
          </div>
          <article className='flex gap-4 rounded-xl bg-slate-900 p-4 ring-1 ring-cyan-400/25'>
            <img src={A('starcraft/sc2-battle.webp')} alt='' width={200} height={120} className='h-28 w-48 shrink-0 rounded-lg object-cover opacity-90' />
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

      {/* 3 清爽极简 */}
      <Frame name='风格 3 · 清爽极简' tagline='白底细线、无阴影、大留白；靠字号与行高做层级'>
        <div className='flex flex-col gap-6 rounded-xl bg-white p-7 text-slate-900'>
          <div className='flex items-start justify-between gap-6'>
            <div>
              <h3 className='text-[28px] font-semibold tracking-tight'>{POST.board}</h3>
              <p className='mt-2 max-w-lg text-[15px] leading-7 text-slate-500'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus}>发帖</VividButton>
          </div>
          <div className='flex flex-col divide-y divide-slate-100'>
            {LIST.map((t) => (
              <article key={t.title} className='flex items-start gap-4 py-5 first:pt-0 last:pb-0'>
                <img src={A('starcraft/sc2-battle.webp')} alt='' width={96} height={64} className='h-16 w-24 shrink-0 rounded-md object-cover' />
                <div className='flex min-w-0 flex-col gap-1.5'>
                  <h4 className='text-[17px] font-medium leading-7 text-slate-900'>{t.title}</h4>
                  <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-slate-500'>
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

      {/* 4 暖色亲和 */}
      <Frame name='风格 4 · 暖色亲和' tagline='米白底、珊瑚强调色、柔和阴影与超大字距，偏社区温度'>
        <div className='flex flex-col gap-4 rounded-2xl bg-[#fffaf3] p-6 text-stone-800'>
          <div className='flex items-start justify-between gap-4'>
            <div>
              <h3 className='text-3xl font-bold tracking-tight text-stone-900'>{POST.board}</h3>
              <p className='mt-1.5 text-base leading-relaxed text-stone-500'>{POST.intro}</p>
            </div>
            <VividButton size='lg' icon={Plus} className='bg-[#f97316] shadow-lg shadow-orange-500/25'>发帖</VividButton>
          </div>
          <article className='flex gap-4 rounded-2xl bg-white p-4 shadow-sm shadow-orange-900/5'>
            <img src={A('starcraft/sc2-battle.webp')} alt='' width={200} height={120} className='h-28 w-48 shrink-0 rounded-xl object-cover' />
            <div className='flex min-w-0 flex-col gap-2'>
              <h4 className='text-xl font-bold leading-relaxed'>{POST.title}</h4>
              <p className='line-clamp-2 text-[15px] leading-relaxed text-stone-600'>{POST.excerpt}</p>
              <div className='flex items-center gap-4 text-sm text-stone-500'>
                <UserBadge user={AUTHOR} size='sm' />
                <span>{POST.replies} 人回过</span>
                <span>{POST.likes} 人点赞</span>
              </div>
            </div>
          </article>
          <div className='flex flex-wrap gap-3'>
            <VividButton size='lg' icon={Heart} className='bg-[#f97316] shadow-lg shadow-orange-500/25'>赞赏作者</VividButton>
            <VividButton size='lg' className='bg-white text-stone-700 shadow-sm ring-1 ring-stone-200'>收藏</VividButton>
            <VividButton size='lg' className='bg-transparent text-stone-500' icon={Share2}>分享</VividButton>
          </div>
        </div>
      </Frame>
    </div>
  );
}
