import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  Check,
  CircleAlert,
  Eye,
  Flame,
  Heart,
  Inbox,
  MessageSquare,
  Moon,
  PenLine,
  Pin,
  RefreshCw,
  Sparkles,
  Star,
  Sun,
  User,
} from 'lucide-react';
import Avatar from '@jetbrains/ring-ui-built/components/avatar/avatar';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { cn } from '@/lib/utils';
import { currentTheme, toggleTheme } from '@/lib/theme';
import type { Theme } from '@/lib/theme';

/* 方向 B / v2：密度档位更高的一版——左导航栏 + 右信息栏 + 封面置顶卡片网格。
   与 v1 的差别是结构而非配色：导航离开顶栏、封面从侧边缩略图变成卡片头图、
   列表从「一条一行」变成「两列卡片」，右栏承担站点公告与活跃作者。
   字段名与后端方案 §21.3 逐字对齐，换掉 fakeTopics 即可接真接口。 */

type TopicKind = 'discussion' | 'resource' | 'repost';

type TopicItem = {
  id: string;
  board: { slug: string; name: string };
  kind: TopicKind;
  title: string;
  excerpt: string;
  author: { handle: string; nickname: string };
  reply_count: number;
  like_count: number;
  view_count: number;
  pinned_at: string | null;
  featured_at: string | null;
  last_reply_at: string;
  cover: boolean;
};

type TopicPage = { data: TopicItem[]; next_cursor: string | null };

const BOARDS = [
  { slug: 'all', name: '全部主题' },
  { slug: 'mod', name: '自制战役' },
  { slug: 'melee', name: '对战与平衡' },
  { slug: 'galaxy', name: '银河编辑器' },
  { slug: 'tool', name: '工具与启动器' },
  { slug: 'replay', name: '录像复盘' },
  { slug: 'art', name: '地图美术' },
];

const FEED: TopicItem[] = [
  {
    id: 't_9f21',
    board: { slug: 'mod', name: '自制战役' },
    kind: 'resource',
    title: '《星海余烬》完整战役 v2.4：九关全语音，含分支结局与存档继承',
    excerpt: '第七关演出重做，补两条支线结局；存档继承可读旧版本通关记录。',
    author: { handle: 'tangtian', nickname: '唐天' },
    reply_count: 128,
    like_count: 342,
    view_count: 12840,
    pinned_at: '2026-10-05T09:00:00Z',
    featured_at: '2026-09-28T08:00:00Z',
    last_reply_at: '2026-10-12T03:41:00Z',
    cover: true,
  },
  {
    id: 't_31ab',
    board: { slug: 'melee', name: '对战与平衡' },
    kind: 'discussion',
    title: '4.11 之后 ZvT 的中期节奏被拉长了吗',
    excerpt: '400 场高分段录像里，中期交火时间点整体后移约 40 秒。',
    author: { handle: 'zergling_42', nickname: '小狗四十二' },
    reply_count: 213,
    like_count: 174,
    view_count: 9670,
    pinned_at: null,
    featured_at: '2026-10-01T10:00:00Z',
    last_reply_at: '2026-10-11T23:58:00Z',
    cover: true,
  },
  {
    id: 't_5d77',
    board: { slug: 'tool', name: '工具与启动器' },
    kind: 'resource',
    title: '启动器 0.9.7：多实例共存、地图包校验、离线模式',
    excerpt: '坏包在启动前就会报出来，不会再进游戏才崩。',
    author: { handle: 'launcher', nickname: '启动器维护组' },
    reply_count: 64,
    like_count: 205,
    view_count: 7215,
    pinned_at: null,
    featured_at: null,
    last_reply_at: '2026-10-11T19:20:00Z',
    cover: true,
  },
  {
    id: 't_7c05',
    board: { slug: 'galaxy', name: '银河编辑器' },
    kind: 'discussion',
    title: 'actor 事件里 Send 的求值顺序到底怎么定的',
    excerpt: '同一个 actor 上三条 On Terms，实测顺序与书写顺序不一致。',
    author: { handle: 'kirinDev', nickname: '麒麟工坊' },
    reply_count: 46,
    like_count: 88,
    view_count: 3120,
    pinned_at: null,
    featured_at: null,
    last_reply_at: '2026-10-12T02:12:00Z',
    cover: false,
  },
  {
    id: 't_2e18',
    board: { slug: 'art', name: '地图美术' },
    kind: 'repost',
    title: '转载：一套可商用的科幻地面贴图（4K + 法线）',
    excerpt: '62 张贴图，CC-BY 4.0，署名要求写在 LICENSE 里。',
    author: { handle: 'mapcraft', nickname: '地图工房' },
    reply_count: 31,
    like_count: 97,
    view_count: 2580,
    pinned_at: null,
    featured_at: null,
    last_reply_at: '2026-10-11T14:02:00Z',
    cover: true,
  },
  {
    id: 't_8b93',
    board: { slug: 'galaxy', name: '银河编辑器' },
    kind: 'discussion',
    title: 'Galaxy 里做对象池值得吗：2000 个单位的实测',
    excerpt: '2 核机器上不值得，GC 压力比对象复用省下的更小。',
    author: { handle: 'vibe', nickname: 'Vibe' },
    reply_count: 12,
    like_count: 40,
    view_count: 940,
    pinned_at: null,
    featured_at: null,
    last_reply_at: '2026-10-10T21:30:00Z',
    cover: false,
  },
  {
    id: 't_4a60',
    board: { slug: 'mod', name: '自制战役' },
    kind: 'discussion',
    title: '给新人的路线：从改一个触发器到做完一关',
    excerpt: '把踩过的坑按顺序列了一遍，照这个顺序走能省一半时间。',
    author: { handle: 'guide', nickname: '入门向导' },
    reply_count: 87,
    like_count: 156,
    view_count: 5320,
    pinned_at: null,
    featured_at: null,
    last_reply_at: '2026-10-10T11:15:00Z',
    cover: false,
  },
  {
    id: 't_6c44',
    board: { slug: 'replay', name: '录像复盘' },
    kind: 'discussion',
    title: '一场 42 分钟的 TvP：三次换家怎么翻的盘',
    excerpt: '录像编号与时间轴在正文，第 18 分钟那次空投是转折。',
    author: { handle: 'observer', nickname: '旁观者' },
    reply_count: 23,
    like_count: 61,
    view_count: 1870,
    pinned_at: null,
    featured_at: '2026-10-08T09:00:00Z',
    last_reply_at: '2026-10-09T20:05:00Z',
    cover: true,
  },
];

const HOT_AUTHORS = [
  { handle: 'tangtian', nickname: '唐天', topics: 34 },
  { handle: 'kirinDev', nickname: '麒麟工坊', topics: 21 },
  { handle: 'zergling_42', nickname: '小狗四十二', topics: 18 },
  { handle: 'mapcraft', nickname: '地图工房', topics: 12 },
];

/* 演示用假接口：形状与后端 §21.3 一致。换成 api('/topics?cursor=…') 即可接真数据。
   首次请求固定失败一次，用来演示错误态与「重试不丢已加载内容」。 */
function fakeTopics(cursor: string | null, limit: number, failFirst: boolean): Promise<TopicPage> {
  const offset = cursor ? Number(cursor) : 0;
  const data: TopicItem[] = [];
  for (let i = 0; i < limit; i += 1) {
    const n = offset + i;
    const base = FEED[n % FEED.length];
    if (!base) continue;
    data.push(
      n < FEED.length
        ? base
        : {
            ...base,
            id: base.id + '_p' + String(n),
            pinned_at: null,
            featured_at: null,
            cover: n % 3 !== 2,
            reply_count: 6 + ((n * 13) % 80),
            like_count: 4 + ((n * 9) % 55),
            view_count: 280 + ((n * 271) % 3600),
            last_reply_at: new Date(Date.parse('2026-10-09T18:00:00Z') - n * 6.1e6).toISOString(),
          },
    );
  }
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (offset === 0 && failFirst) reject(new Error('network'));
      else resolve({ data, next_cursor: offset + limit < 36 ? String(offset + limit) : null });
    }, 420);
  });
}

/* ── 令牌内的绘图件：只有文字与几何，没有任何图片字节 ─────────────────────── */

/* 封面是 <img> 加载的 SVG：CSS 变量在 <img> 里解析不了（实测 --primary 会退成黑色），
   所以图内一律用 currentColor，颜色由容器上的文字色类决定。 */
const COVER_INK = ['text-primary', 'text-foreground', 'text-muted-foreground'];

/* 版块色带的纹理用 SVG 元素画：5 条竖线 + 一组斜线。
   不用 SVG <pattern>——它的 id 是文档级的，一个页面上多张封面必然撞名。 */
const GRID_LINE = <line stroke='currentColor' strokeOpacity='.22' strokeWidth='1.5' x1='0' x2='0' y1='0' y2='800' />;
const GRID_SLASH = <line stroke='currentColor' strokeOpacity='.16' strokeWidth='1.5' x1='0' x2='0' y1='-400' y2='1200' />;

/** 封面：内联 SVG 画的抽象图（真实项目这里是 /img/<hash> 缩略图，≤60KB 由后端生成）。 */
function CoverArt({ seed, title }: { seed: number; title: string }) {
  return (
    <svg
      aria-hidden
      className='size-full'
      focusable='false'
      preserveAspectRatio='xMidYMid slice'
      viewBox='0 0 1200 800'
    >
      <rect fill='currentColor' fillOpacity='.08' height='800' width='1200' />
      <g>
        {[0, 50, 150, 700, 750].map((x) => (
          <g key={x} transform={'translate(' + x + ' 0)'}>
            {GRID_LINE}
          </g>
        ))}
        {[0, 50, 150, 700, 750].map((x) => (
          <g key={'s' + x} transform={'translate(' + x + ' 0) rotate(18)'}>
            {GRID_SLASH}
          </g>
        ))}
      </g>
      <circle
        cx={300 + (seed % 5) * 120}
        cy={430}
        fill='none'
        r={210}
        stroke='currentColor'
        strokeOpacity='.5'
        strokeWidth={22}
      />
      <circle
        cx={840 - (seed % 4) * 100}
        cy={510}
        fill='none'
        r={140}
        stroke='currentColor'
        strokeOpacity='.35'
        strokeWidth={14}
      />
      <path d='M0 690L1200 540' fill='none' stroke='currentColor' strokeOpacity='.3' strokeWidth={10} />
      <title>{title}</title>
    </svg>
  );
}


function seedOf(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) n = (n * 31 + text.charCodeAt(i)) % 997;
  return n;
}


const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const wall = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

/** 只做「UTC ISO → 相对时间」的展示换算，本地时区只在这里出现。 */
function relative(iso: string, now: number): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return String(min) + ' 分钟前';
  if (min < 1440) return String(Math.floor(min / 60)) + ' 小时前';
  if (min < 1440 * 7) return String(Math.floor(min / 1440)) + ' 天前';
  return wall.format(new Date(iso));
}

const KIND: Record<TopicKind, { text: string; cls: string }> = {
  discussion: { text: '讨论', cls: 'border-border text-muted-foreground' },
  resource: { text: '资源', cls: 'border-primary text-primary' },
  repost: { text: '转载', cls: 'border-foreground/40 text-foreground' },
};

/** 头像交给 Ring UI 的 Avatar：没给 url 时它自带 fallback（渐变 + 首字母），
   真实项目只要把 url 换成 /img/<hash> 即可。演示数据不带头像，正好走 fallback。 */
/* size 只能是 16/18/20/24/28/32/40/48/56：其它值会让 Ring UI 的 fallback 抛错 */
function UserAvatar({ nickname, size }: { nickname: string; size: number }) {
  return <Avatar className='shrink-0' round size={size} username={nickname} />;
}

function KindBadge({ kind }: { kind: TopicKind }) {
  const k = KIND[kind];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm border px-1.5 py-px text-[11px] leading-4',
        k.cls,
      )}
    >
      {k.text}
    </span>
  );
}

/** 置顶与精华：v2 用「卡片左侧色条 + 角标」，因为卡片网格里没有行首竖线可用。 */
function CardMarks({ topic, className }: { topic: TopicItem; className?: string }) {
  if (topic.pinned_at === null && topic.featured_at === null) return null;
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5', className)}>
      {topic.pinned_at !== null ? (
        <span className='inline-flex items-center gap-1 rounded-sm bg-primary px-1.5 py-px text-[11px] leading-4 text-primary-foreground'>
          <Pin aria-hidden className='size-3' />
          置顶
        </span>
      ) : null}
      {topic.featured_at !== null ? (
        <span className='inline-flex items-center gap-1 rounded-sm border border-primary px-1.5 py-px text-[11px] leading-4 text-primary'>
          <Star aria-hidden className='size-3' />
          精华
        </span>
      ) : null}
    </span>
  );
}

function TopicCard({ topic, now }: { topic: TopicItem; now: number }) {
  const marked = topic.pinned_at !== null || topic.featured_at !== null;
  const seed = seedOf(topic.title);
  return (
    <article
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-border bg-card',
        marked && 'border-l-2 border-l-primary',
      )}
    >
      {topic.cover ? (
        <div className={cn('relative aspect-video w-full bg-muted', COVER_INK[seed % COVER_INK.length])}>
          {/* 固定宽高比容器：图未到时高度已占住，CLS 为 0（前端方案 §9.1） */}
          <div className='absolute inset-0'>
            <CoverArt seed={seed} title={topic.board.name + ' 封面'} />
          </div>
          {/* 角标压在封面图上：垫一层背景色，否则遇到同色封面就读不出来 */}
          <div className='absolute top-0 left-0 rounded-br-lg bg-background/85 p-2.5 backdrop-blur-sm'>
            <CardMarks topic={topic} />
          </div>
        </div>
      ) : null}

      <div className='flex min-w-0 flex-col p-5'>
        {topic.cover ? null : <CardMarks className='mb-3' topic={topic} />}
        <div className='flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground'>
          <a className='font-medium text-foreground hover:underline' href={'#b/' + topic.board.slug}>
            {topic.board.name}
          </a>
          <KindBadge kind={topic.kind} />
        </div>

        <h2 className='mt-2 text-[17px] leading-[1.45] font-semibold text-foreground'>
          <a
            className='rounded-sm outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
            href={'#t/' + topic.id}
          >
            {topic.title}
          </a>
        </h2>
        <p className='mt-2 line-clamp-2 text-[13px] leading-[1.75] text-muted-foreground'>{topic.excerpt}</p>

        <div className='mt-auto flex items-center gap-3 pt-5'>
          <UserAvatar nickname={topic.author.nickname} size={24} />
          <span className='text-[12px] text-foreground'>{topic.author.nickname}</span>
          <span className='ml-auto flex items-center gap-3 text-[12px] text-muted-foreground tabular-nums'>
            <span className='flex items-center gap-1' title='回复数'>
              <MessageSquare aria-hidden className='size-3.5' />
              {topic.reply_count}
            </span>
            <span className='flex items-center gap-1' title='点赞数'>
              <Heart aria-hidden className='size-3.5' />
              {topic.like_count}
            </span>
            <span className='flex items-center gap-1' title='浏览数'>
              <Eye aria-hidden className='size-3.5' />
              {compact.format(topic.view_count)}
            </span>
          </span>
        </div>
        <div className='mt-3 border-t border-border pt-3 text-[12px] text-muted-foreground tabular-nums'>
          最后回复 {relative(topic.last_reply_at, now)}
        </div>
      </div>
    </article>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className='overflow-hidden rounded-lg border border-border bg-card'>
      <div className='aspect-video w-full bg-muted' />
      <div className='space-y-3 p-5'>
        <div className='h-3 w-24 rounded-sm bg-muted' />
        <div className='h-5 w-11/12 rounded-sm bg-muted' />
        <div className='h-3 w-2/3 rounded-sm bg-muted' />
        <div className='h-6 w-32 rounded-sm bg-muted' />
      </div>
    </div>
  );
}

/* ── 顶栏（站点标识 / 搜索 / 版块 / 发帖 / 通知 / 用户 / 深浅色） ─────────── */

function TopBar({
  theme,
  onTheme,
  onSearch,
}: {
  theme: Theme;
  onTheme: () => void;
  onSearch: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  return (
    <header className='sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur'>
      <div className='flex h-14 w-full items-center gap-4 px-4 sm:px-6'>
        <a
          className='flex shrink-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 xl:hidden'
          href='#/'
        >
          <span className='text-[17px] font-semibold tracking-[-0.02em] text-foreground'>SC2clud</span>
        </a>

        <form
          className='min-w-0 flex-1 sm:max-w-md'
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(q.trim());
          }}
          role='search'
        >
          <Input
            aria-label='搜索主题'
            onChange={(e) => setQ(e.target.value)}
            placeholder='搜索主题、作者、版块…'
            size={Size.S}
            value={q}
          />
        </form>

        <nav
          aria-label='版块快捷入口'
          className='hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto xl:flex'
        >
          {BOARDS.slice(1, 6).map((b) => (
            <a
              className='shrink-0 rounded-md px-2.5 py-1 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'
              href={'#b/' + b.slug}
              key={b.slug}
            >
              {b.name}
            </a>
          ))}
        </nav>

        <a
          className='hidden shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:flex'
          href='#new'
        >
          <PenLine aria-hidden className='size-4' />
          发帖
        </a>
        {/* 通知：未读角标用 relative 容器套一个圆点；控件仍是 Ring UI 的 Button */}
        <span className='relative shrink-0'>
          <Button aria-label='通知（3 条未读）' ghost icon={Bell} />
          <span className='absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive' />
        </span>
        <Button
          className='h-8 shrink-0 gap-1.5 px-3 text-[13px]'
          ghost
          icon={theme === 'dark' ? Sun : Moon}
          onClick={onTheme}
        >
          {theme === 'dark' ? '浅色' : '深色'}
        </Button>
        <a
          className='flex shrink-0 items-center gap-2 rounded-full p-0.5 pr-1 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 xl:pr-3'
          href='#u/tangtian'
        >
          <UserAvatar nickname='唐天' size={32} />
          <span className='hidden text-[13px] text-foreground xl:inline'>唐天</span>
        </a>
      </div>
    </header>
  );
}

/* ── 左导航栏：站点标识 + 版块 + 站点公告（≥1024 出现） ───────────────────── */

function LeftRail() {
  return (
    <aside className='sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 flex-col overflow-y-auto border-r border-border px-3 py-5 lg:flex'>
      <a className='flex items-center gap-2 px-2 pb-5' href='#/'>
        <span className='rounded-md bg-primary px-1.5 py-1 font-mono text-[12px] font-semibold text-primary-foreground'>
          SC2
        </span>
        <span className='text-[16px] font-semibold tracking-[-0.02em] text-foreground'>SC2clud</span>
      </a>

      <nav aria-label='版块导航' className='flex flex-col gap-0.5'>
        {BOARDS.map((b) => (
          <a
            aria-current={b.slug === 'all' ? 'page' : undefined}
            className='rounded-md px-2.5 py-2 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:bg-primary/10 aria-[current=page]:font-semibold aria-[current=page]:text-primary'
            href={'#b/' + b.slug}
            key={b.slug}
          >
            {b.name}
          </a>
        ))}
      </nav>

      <div className='mt-6 rounded-lg border border-border bg-muted/40 p-4'>
        <p className='flex items-center gap-1.5 text-[12px] font-semibold text-foreground'>
          <Sparkles aria-hidden className='size-4 text-primary' />
          站点公告
        </p>
        <p className='mt-2 text-[12px] leading-[1.7] text-muted-foreground'>
          服务器已升级到 4GB 档位：列表页改用缩略图，私信延迟降到 1 秒内。
        </p>
        <p className='mt-3 text-[12px] font-semibold text-primary'>
          查看全部公告 →
        </p>
      </div>

      <div className='mt-auto flex items-center gap-3 px-2 pt-6 text-[12px] text-muted-foreground'>
        <a className='hover:underline' href='#about'>
          关于
        </a>
        <a className='hover:underline' href='#rules'>
          版规
        </a>
        <a className='hover:underline' href='#download'>
          下载启动器
        </a>
      </div>
    </aside>
  );
}

/* ── 右信息栏：社区数据 + 活跃作者 + 最新回复（≥1280 出现） ───────────────── */

function RightRail({ now }: { now: number }) {
  return (
    <aside className='sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border px-5 py-5 xl:flex'>
      <section className='rounded-lg border border-border bg-card p-4'>
        <h2 className='flex items-center gap-1.5 text-[13px] font-semibold text-foreground'>
          <Flame aria-hidden className='size-4 text-primary' />
          今日社区
        </h2>
        <dl className='mt-3 grid grid-cols-2 gap-3 text-[12px]'>
          <div>
            <dt className='text-muted-foreground'>新主题</dt>
            <dd className='mt-0.5 text-[19px] font-semibold text-foreground tabular-nums'>42</dd>
          </div>
          <div>
            <dt className='text-muted-foreground'>新回复</dt>
            <dd className='mt-0.5 text-[19px] font-semibold text-foreground tabular-nums'>318</dd>
          </div>
          <div>
            <dt className='text-muted-foreground'>当前在线</dt>
            <dd className='mt-0.5 text-[19px] font-semibold text-foreground tabular-nums'>76</dd>
          </div>
          <div>
            <dt className='text-muted-foreground'>今日注册</dt>
            <dd className='mt-0.5 text-[19px] font-semibold text-foreground tabular-nums'>9</dd>
          </div>
        </dl>
      </section>

      <section className='rounded-lg border border-border bg-card p-4'>
        <h2 className='flex items-center gap-1.5 text-[13px] font-semibold text-foreground'>
          <User aria-hidden className='size-4 text-primary' />
          本周活跃作者
        </h2>
        <ul className='mt-3 flex flex-col gap-3'>
          {HOT_AUTHORS.map((a) => (
            <li className='flex items-center gap-3' key={a.handle}>
              <UserAvatar nickname={a.nickname} size={28} />
              <a className='text-[13px] text-foreground hover:underline' href={'#u/' + a.handle}>
                {a.nickname}
              </a>
              <span className='ml-auto text-[12px] text-muted-foreground tabular-nums'>
                {a.topics} 主题
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className='rounded-lg border border-border bg-card p-4'>
        <h2 className='text-[13px] font-semibold text-foreground'>最新回复</h2>
        <ul className='mt-3 flex flex-col gap-3 text-[12px] text-muted-foreground'>
          <li className='leading-snug'>
            <span className='text-foreground'>麒麟工坊</span> 回复了「actor 事件里 Send 的求值顺序」
            <span className='mt-1 block tabular-nums'>{relative('2026-10-12T03:41:00Z', now)}</span>
          </li>
          <li className='leading-snug'>
            <span className='text-foreground'>小狗四十二</span> 回复了「4.11 之后 ZvT 的中期节奏」
            <span className='mt-1 block tabular-nums'>{relative('2026-10-12T01:10:00Z', now)}</span>
          </li>
          <li className='leading-snug'>
            <span className='text-foreground'>地图工房</span> 回复了「转载：可商用科幻贴图」
            <span className='mt-1 block tabular-nums'>{relative('2026-10-11T22:05:00Z', now)}</span>
          </li>
        </ul>
      </section>

      <p className='mt-auto px-1 text-[11px] leading-relaxed text-muted-foreground'>
        方向 B / v2 密度档：三栏 ≥1280 · 双栏 ≥1024 · 单栏（含卡片合并为一行）&lt;1024
      </p>
    </aside>
  );
}

/* ── 页面 ──────────────────────────────────────────────────────────────── */

export default function StyleBDenseGrid() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [list, setList] = useState<TopicItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'more' | 'ready' | 'empty' | 'error'>('loading');
  const [notice, setNotice] = useState('');
  const [now] = useState(() => Date.now());
  const mode = useRef<'load' | 'more' | 'empty'>('load');
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  /* 演示开关：forceError 用来点出错误态 */
  const forceError = useRef(false);

  const acquire = useCallback(async () => {
    if (loadingRef.current) return;
    if (mode.current === 'empty') {
      setState('empty');
      return;
    }
    loadingRef.current = true;
    const first = mode.current === 'load';
    setState(first ? 'loading' : 'more');
    try {
      const page = await fakeTopics(cursorRef.current, first ? 8 : 6, forceError.current);
      setList((prev) => (first ? page.data : prev.concat(page.data)));
      cursorRef.current = page.next_cursor;
      setCursor(page.next_cursor);
      setState('ready');
    } catch {
      setState('error');
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void acquire();
  }, [acquire]);

  const reload = () => {
    mode.current = 'load';
    forceError.current = false;
    cursorRef.current = null;
    setCursor(null);
    setList([]);
    void acquire();
  };

  return (
    <div className='style-b-v2 flex min-h-screen flex-col bg-background text-foreground'>
      {/* 方向内的令牌覆盖：只在本容器生效，不动全局（前端方案 §7.1） */}
      <style>{'.style-b-v2{--radius:8px}'}</style>

      <TopBar
        onSearch={(q) =>
          setNotice(q ? '搜索「' + q + '」：本页是静态预览，未接 /api/v1/search' : '')
        }
        onTheme={() => setTheme(toggleTheme())}
        theme={theme}
      />

      <div className='flex flex-1 justify-center'>
        <LeftRail />

        <main className='min-w-0 flex-1 px-4 pb-20 sm:px-6'>
          <div className='mx-auto w-full max-w-[52rem]'>
            <div className='flex flex-wrap items-end justify-between gap-4 pt-8 pb-5'>
              <div>
                <h1 className='text-[24px] leading-tight font-semibold tracking-[-0.02em] text-foreground'>
                  全部主题
                </h1>
                <p className='mt-1.5 text-[13px] text-muted-foreground'>
                  按最后回复时间排序 · 游标分页，每页 8 条
                </p>
              </div>
              <div className='flex items-center gap-2'>
                <span className='text-[12px] text-muted-foreground'>排序</span>
                <span className='rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground'>
                  最后回复
                </span>
                <span className='rounded-md px-2.5 py-1 text-[12px] text-muted-foreground'>最新发布</span>
              </div>
            </div>

            {/* 窄屏版块导航：左栏被折掉时在这里横滑 */}
            <nav
              aria-label='版块'
              className='-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden'
            >
              {BOARDS.map((b) => (
                <a
                  aria-current={b.slug === 'all' ? 'page' : undefined}
                  className='shrink-0 rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground'
                  href={'#b/' + b.slug}
                  key={b.slug}
                >
                  {b.name}
                </a>
              ))}
            </nav>

            <div className='flex flex-wrap items-center gap-2 pb-4'>
              <span className='mr-1 text-[12px] text-muted-foreground'>预览状态</span>
              <Button className='h-8 px-3.5 text-[13px]' onClick={reload}>
                正常列表
              </Button>
              <Button
                className='h-8 px-3.5 text-[13px]'
                onClick={() => {
                  mode.current = 'empty';
                  cursorRef.current = null;
                  setCursor(null);
                  setList([]);
                  setState('empty');
                }}
              >
                空状态
              </Button>
              <Button
                className='h-8 px-3.5 text-[13px]'
                onClick={() => {
                  mode.current = 'load';
                  forceError.current = true;
                  cursorRef.current = null;
                  setCursor(null);
                  setList([]);
                  void acquire();
                }}
              >
                错误态
              </Button>
            </div>

            {notice ? (
              <p
                aria-live='polite'
                className='mb-4 rounded-md bg-muted px-4 py-3 text-[13px] text-muted-foreground'
              >
                {notice}
              </p>
            ) : null}

            <section aria-busy={state === 'loading'} aria-label='主题列表'>
              {state === 'loading' ? (
                <>
                  <span className='sr-only' role='status'>正在加载主题…</span>
                  <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                    <CardSkeleton />
                    <CardSkeleton />
                    <CardSkeleton />
                    <CardSkeleton />
                  </div>
                </>
              ) : null}

              {state === 'empty' ? (
                <div className='flex flex-col items-center gap-4 rounded-lg border border-dashed border-border py-24 text-center'>
                  <span className='rounded-full bg-muted p-4 text-muted-foreground'>
                    <Inbox aria-hidden className='size-7' />
                  </span>
                  <h2 className='text-[19px] font-semibold text-foreground'>这个版块还没有主题</h2>
                  <p className='max-w-[24rem] text-[13px] leading-relaxed text-muted-foreground'>
                    筛选条件也可能是原因：换个版块，或者清掉搜索词再看一次。
                  </p>
                  <a
                    className='rounded-md bg-primary px-5 py-2.5 text-[13px] font-semibold text-primary-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                    href='#new'
                  >
                    发布第一个主题
                  </a>
                </div>
              ) : null}

              {list.length > 0 ? (
                <div className='grid grid-cols-1 items-start gap-4 sm:grid-cols-2'>
                  {list.map((t) => (
                    <TopicCard key={t.id} now={now} topic={t} />
                  ))}
                </div>
              ) : null}

              {state === 'error' ? (
                <div className='mt-4 flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6' role='alert'>
                  <span className='flex items-center gap-2 text-[15px] font-semibold text-foreground'>
                    <CircleAlert aria-hidden className='size-5 text-destructive' />
                    列表没能加载出来
                  </span>
                  <p className='text-[13px] text-muted-foreground'>
                    服务端返回 common.internal 或网络中断。已加载的卡片会保留，重试只补缺的那部分。
                  </p>
                  <Button className='h-8 px-3.5 text-[13px]' onClick={reload}>
                    <RefreshCw aria-hidden className='size-4' />
                    重试
                  </Button>
                </div>
              ) : null}
            </section>

            {state === 'more' ? (
              <div className='grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2'>
                <CardSkeleton />
                <CardSkeleton />
              </div>
            ) : null}

            {state === 'ready' && cursor ? (
              <div className='flex justify-center pt-8'>
                <Button
                  className='h-10 px-6 text-[14px]'
                  onClick={() => {
                    mode.current = 'more';
                    void acquire();
                  }}
                >
                  加载更多
                </Button>
              </div>
            ) : null}

            {state === 'ready' && !cursor && list.length > 0 ? (
              <p className='flex items-center justify-center gap-2 pt-8 text-[12px] text-muted-foreground'>
                <Check aria-hidden className='size-4' />
                已经到底了 · 共 {list.length} 条
              </p>
            ) : null}
          </div>
        </main>

        <RightRail now={now} />
      </div>

      <footer className='border-t border-border'>
        <div className='flex flex-wrap items-center justify-between gap-3 px-6 py-6 text-[12px] text-muted-foreground'>
          <span>SC2clud · 星际争霸 II 中文社区</span>
          <span className='flex items-center gap-2'>
            <Sparkles aria-hidden className='size-4' />
            方向 B / v2 密度档
          </span>
        </div>
      </footer>
    </div>
  );
}
