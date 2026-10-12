import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  CircleAlert,
  Eye,
  Heart,
  Inbox,
  MessageSquare,
  Moon,
  Pin,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Sun,
} from 'lucide-react';
import Avatar from '@jetbrains/ring-ui-built/components/avatar/avatar';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { cn } from '@/lib/utils';
import { currentTheme, toggleTheme } from '@/lib/theme';
import type { Theme } from '@/lib/theme';

/* 方向 B / v1：内容优先，单栏，无侧栏，封面图主导。
   视觉层级靠字号与留白（标题 26px / 正文 15px / 元信息 13px），不靠边框与卡片。
   封面缩略图在右侧，把文字列压窄，从而拉长阅读节奏。
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
  { slug: 'all', name: '全部' },
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
    excerpt:
      '这一版把第七关的演出整个重做了，另外补上两条支线的结局动画。存档继承终于能用，旧版本的通关记录会直接读进来。',
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
    id: 't_7c05',
    board: { slug: 'galaxy', name: '银河编辑器' },
    kind: 'discussion',
    title: 'actor 事件里 Send 的求值顺序到底怎么定的？文档没写清楚的那一段',
    excerpt:
      '同一个 CActorModel 上挂了三条 On Terms，实测顺序和 XML 里的书写顺序并不一致。有人摸清过规则吗，还是只能靠 parent 链兜底。',
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
    id: 't_31ab',
    board: { slug: 'melee', name: '对战与平衡' },
    kind: 'discussion',
    title: '4.11 之后 ZvT 的中期节奏被拉长了吗：从天梯前 200 的录像里看到的趋势',
    excerpt:
      '抽了最近 400 场高分段对局，中期交火时间点整体后移约 40 秒。是地图池的原因，还是虫族经济改动带来的。',
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
    title: 'SC2clud 启动器 0.9.7：多实例共存、地图包校验、离线模式',
    excerpt:
      '这次加了地图包哈希校验，坏包在启动前就会报出来，不会再进游戏才崩。多实例共存要给每个实例单独指定数据目录。',
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
    id: 't_2e18',
    board: { slug: 'art', name: '地图美术' },
    kind: 'repost',
    title: '转载：一套可商用的科幻地面贴图（含 4K 与法线），作者已授权转载',
    excerpt: '原帖在作者的个人站，已取得书面授权。包内 62 张贴图，全部 CC-BY 4.0，署名要求写在 LICENSE 里。',
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
    title: 'Galaxy 里做对象池值得吗：实测 2000 个单位下的行为差别',
    excerpt: '结论是：在 2 核机器上不值得，GC 压力比对象复用省下来的那点更小。附压测脚本与数据表。',
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
    title: '给新人的一条路线：从改一个触发器到做完一关要多久',
    excerpt: '把自己两年前踩过的坑按顺序列了一遍，按这个顺序走大概能省掉一半时间。欢迎补充。',
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
    title: '一场 42 分钟的 TvP：从被压到翻盘，关键的三次换家',
    excerpt: '录像编号与时间轴都在正文里，第 18 分钟那次空投是全场转折。',
    author: { handle: 'observer', nickname: '旁观者' },
    reply_count: 23,
    like_count: 61,
    view_count: 1870,
    pinned_at: null,
    featured_at: null,
    last_reply_at: '2026-10-09T20:05:00Z',
    cover: false,
  },
];

/* 演示用假接口：形状与后端 §21.3 一致。注释掉这里换成 api('/topics?cursor=…') 即可。
   首屏固定第一次就失败，用来演示错误态；#loading 之外的路径都会成功。 */
function fakeTopics(cursor: string | null, limit: number, failFirst: boolean): Promise<TopicPage> {
  const offset = cursor ? Number(cursor) : 0;
  const item: TopicItem[] = [];
  for (let i = 0; i < limit; i += 1) {
    const base = FEED[(offset + i) % FEED.length];
    if (!base) continue;
    const n = offset + i;
    item.push(
      n < FEED.length
        ? base
        : {
            ...base,
            id: base.id + '_p' + String(n),
            pinned_at: null,
            featured_at: null,
            cover: n % 3 === 1,
            reply_count: 7 + ((n * 11) % 90),
            like_count: 3 + ((n * 7) % 60),
            view_count: 320 + ((n * 233) % 4000),
            last_reply_at: new Date(Date.parse('2026-10-09T18:00:00Z') - n * 5.4e6).toISOString(),
          },
    );
  }
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (offset === 0 && failFirst) reject(new Error('network'));
      else resolve({ data: item, next_cursor: offset + limit < 40 ? String(offset + limit) : null });
    }, 460);
  });
}

/* ── 令牌内的绘图件：只有文字与几何，没有任何图片字节 ─────────────────────── */

const INK = ['var(--primary)', 'var(--foreground)', 'var(--muted-foreground)'];

/** 封面：用令牌变量画的抽象图（真实项目这里是 /img/<hash> 缩略图，≤60KB 由后端生成）。 */
function coverImage(seed: number): string {
  const ink = INK[seed % INK.length];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">' +
    '<defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse">' +
    '<path d="M64 0H0V64" fill="none" stroke="' + ink + '" stroke-opacity=".14"/></pattern></defs>' +
    '<rect width="1200" height="800" fill="' + ink + '" fill-opacity=".08"/>' +
    '<rect width="1200" height="800" fill="url(#p)"/>' +
    '<circle cx="' + String(280 + (seed % 5) * 130) + '" cy="430" r="220" fill="none" stroke="' + ink +
    '" stroke-opacity=".5" stroke-width="22"/>' +
    '<circle cx="' + String(820 - (seed % 4) * 90) + '" cy="500" r="150" fill="none" stroke="' + ink +
    '" stroke-opacity=".32" stroke-width="14"/>' +
    '<path d="M0 706L1200 528" stroke="' + ink + '" stroke-opacity=".28" stroke-width="10"/>' +
    '</svg>';
  return dataUrl(svg);
}


function seedOf(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) n = (n * 31 + text.charCodeAt(i)) % 997;
  return n;
}

const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const wall = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

/** 数据 URL 的手工编码：encodeURIComponent 会把中文与 < > 一起码掉，体积翻三倍。 */
function dataUrl(svg: string): string {
  return 'data:image/svg+xml,' + svg.split('#').join('%23').split('\n').join('');
}

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
  discussion: { text: '讨论', cls: 'text-muted-foreground' },
  resource: { text: '资源', cls: 'text-primary' },
  repost: { text: '转载', cls: 'text-foreground' },
};

/* ── 展示组件 ───────────────────────────────────────────────────────────── */

/** 头像直接用 Ring UI 的 Avatar（库已有，不自建）；url 失败时它会回落到首字母。 */
function UserAvatar({ handle, nickname, size }: { handle: string; nickname: string; size: number }) {
  return <Avatar className='shrink-0' round size={size} url={avatarUrl(handle)} username={nickname} />;
}

/** 演示头像：真实项目这里是 /img/<hash>（后端生成的缩略图）。 */
function avatarUrl(handle: string): string {
  const ink = INK[seedOf(handle) % INK.length];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<rect width="96" height="96" rx="28" fill="' + ink + '" fill-opacity=".16"/>' +
    '<circle cx="48" cy="48" r="30" fill="none" stroke="' + ink + '" stroke-opacity=".55" stroke-width="3"/>' +
    '<text x="48" y="60" text-anchor="middle" font-family="ui-monospace,monospace" font-size="34" fill="' +
    ink +
    '">' +
    handle.slice(0, 1).toUpperCase() +
    '</text></svg>';
  return dataUrl(svg);
}

function KindPill({ kind }: { kind: TopicKind }) {
  const k = KIND[kind];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm border border-border px-1.5 py-px text-[11px] leading-4',
        k.cls,
      )}
    >
      {k.text}
    </span>
  );
}

/** 置顶与精华：竖线 + 标记，不改字号也不加背景，避免和「精华」抢视觉。 */
function Marks({ topic }: { topic: TopicItem }) {
  if (topic.pinned_at === null && topic.featured_at === null) return null;
  return (
    <span className='flex shrink-0 items-center gap-1.5'>
      {topic.pinned_at !== null ? (
        <span className='inline-flex items-center gap-1 rounded-sm bg-primary px-1.5 py-px text-[11px] leading-4 text-primary-foreground'>
          <Pin aria-hidden className='size-3' />
          置顶
        </span>
      ) : null}
      {topic.featured_at ? (
        <span className='inline-flex items-center gap-1 rounded-sm border border-primary px-1.5 py-px text-[11px] leading-4 text-primary'>
          <Star aria-hidden className='size-3' />
          精华
        </span>
      ) : null}
    </span>
  );
}

function Cover({ topic, className }: { topic: TopicItem; className?: string }) {
  if (!topic.cover) return null;
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-muted', className)}>
      {/* 定宽高比容器：图未到时高度已占住，CLS 为 0（前端方案 §9.1） */}
      <img
        alt={''}
        className='size-full object-cover'
        loading='lazy'
        src={coverImage(seedOf(topic.title))}
      />
    </div>
  );
}

function TopicRow({ topic, now }: { topic: TopicItem; now: number }) {
  const marked = topic.pinned_at !== null || topic.featured_at !== null;
  return (
    <article
      className={cn(
        'border-t border-border py-9 first:border-t-0 sm:py-11',
        marked && '-ml-4 border-l-2 border-l-primary pl-4 sm:-ml-6 sm:pl-6',
      )}
    >
      <div className='flex items-start gap-6 sm:gap-10'>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground'>
            <Marks topic={topic} />
            <a
              className='font-medium text-foreground underline-offset-4 hover:underline'
              href={'#b/' + topic.board.slug}
            >
              {topic.board.name}
            </a>
            <KindPill kind={topic.kind} />
          </div>

          <h2 className='mt-3 text-[22px] leading-[1.35] font-semibold tracking-[-0.01em] text-foreground sm:text-[26px]'>
            <a
              className='rounded-sm outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
              href={'#t/' + topic.id}
            >
              {topic.title}
            </a>
          </h2>

          <p className='mt-3 line-clamp-2 max-w-[46rem] text-[15px] leading-[1.8] text-muted-foreground'>
            {topic.excerpt}
          </p>

          <div className='mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground'>
            <span className='flex items-center gap-2'>
              <UserAvatar handle={topic.author.handle} nickname={topic.author.nickname} size={22} />
              <span className='text-foreground'>{topic.author.nickname}</span>
            </span>
            <span className='flex items-center gap-1.5 tabular-nums'>
              <MessageSquare aria-hidden className='size-4' />
              {topic.reply_count} 回复
            </span>
            <span className='flex items-center gap-1.5 tabular-nums'>
              <Heart aria-hidden className='size-4' />
              {topic.like_count}
            </span>
            <span className='flex items-center gap-1.5 tabular-nums'>
              <Eye aria-hidden className='size-4' />
              {compact.format(topic.view_count)}
            </span>
            <span className='tabular-nums'>最后回复 {relative(topic.last_reply_at, now)}</span>
          </div>
        </div>

        <Cover className='hidden aspect-[4/3] w-[13rem] shrink-0 sm:block lg:w-[19rem]' topic={topic} />
      </div>
      {/* 窄屏：封面沉到文字下方，标题永远第一眼可见 */}
      <Cover className='mt-6 aspect-[16/9] sm:hidden' topic={topic} />
    </article>
  );
}

function Skeleton() {
  return (
    <div aria-hidden className='border-t border-border py-9 first:border-t-0 sm:py-11'>
      <div className='flex items-start gap-10'>
        <div className='flex-1 space-y-4'>
          <div className='h-3 w-28 rounded-sm bg-muted' />
          <div className='h-6 w-11/12 rounded-sm bg-muted' />
          <div className='h-6 w-2/3 rounded-sm bg-muted' />
          <div className='h-3 w-2/5 rounded-sm bg-muted' />
        </div>
        <div className='hidden aspect-[4/3] w-[13rem] shrink-0 rounded-md bg-muted sm:block lg:w-[19rem]' />
      </div>
    </div>
  );
}

/* ── 顶栏：站点标识 / 版块导航（可横滑） / 搜索 / 用户区 / 深浅色 ─────────── */

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
    <header className='sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur'>
      <div className='mx-auto flex h-16 w-full max-w-[72rem] items-center gap-4 px-5 sm:h-[4.5rem] sm:gap-8 sm:px-8'>
        <a
          className='flex shrink-0 items-baseline gap-2 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
          href='#/'
        >
          <span className='text-[19px] font-semibold tracking-[-0.02em] text-foreground'>SC2clud</span>
          <span className='hidden text-[13px] text-muted-foreground sm:inline'>社区</span>
        </a>

        <nav
          aria-label='版块'
          className='-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
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

        <form
          className='hidden w-56 shrink-0 lg:block'
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(q.trim());
          }}
          role='search'
        >
          <Input
            aria-label='搜索主题'
            onChange={(e) => setQ(e.target.value)}
            placeholder='搜索主题、作者…'
            size={Size.S}
            value={q}
          />
        </form>

        <a
          aria-label='搜索'
          className='rounded-md p-2 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:hidden'
          href='#search'
        >
          <Search aria-hidden className='size-5' />
        </a>
        <button
          aria-label='切换深浅色'
          className='rounded-md p-2 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'
          onClick={onTheme}
          type='button'
        >
          {theme === 'dark' ? (
            <Sun aria-hidden className='size-5' />
          ) : (
            <Moon aria-hidden className='size-5' />
          )}
        </button>
        <a
          className='flex shrink-0 items-center gap-2 rounded-full p-0.5 pr-1 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:pr-3'
          href='#u/tangtian'
        >
          <UserAvatar handle='tangtian' nickname='唐天' size={32} />
          <span className='hidden text-[13px] text-foreground sm:inline'>唐天</span>
        </a>
      </div>
    </header>
  );
}

/* ── 页面 ──────────────────────────────────────────────────────────────── */

export default function StyleBContentFirst() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [list, setList] = useState<TopicItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'more' | 'ready' | 'empty' | 'error'>('loading');
  const [notice, setNotice] = useState('');
  /* 「现在」固定一次：相对时间不在渲染中读取时钟，避免每秒重排 */
  const [now] = useState(() => Date.now());
  const mode = useRef<'load' | 'more' | 'empty'>('load');
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const sendFailed = useRef(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

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
      const page = await fakeTopics(cursorRef.current, first ? 6 : 4, !sendFailed.current);
      sendFailed.current = true;
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

  /* 游标翻页：触底自动加载；底部同时留按钮（键盘与无 IntersectionObserver 的环境都能用） */
  useEffect(() => {
    const el = sentinel.current;
    if (!el || state !== 'ready' || !cursor) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const ob = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        mode.current = 'more';
        void acquire();
      }
    });
    ob.observe(el);
    return () => ob.disconnect();
  }, [state, cursor, acquire]);

  const reload = () => {
    mode.current = 'load';
    sendFailed.current = false;
    cursorRef.current = null;
    setCursor(null);
    setList([]);
    void acquire();
  };

  return (
    <div className='style-b-v1 min-h-screen bg-background text-foreground'>
      {/* 方向内的令牌覆盖：只在本容器生效，不动全局（前端方案 §7.1） */}
      <style>{'.style-b-v1{--radius:4px}'}</style>

      <TopBar
        onSearch={(q) =>
          setNotice(q ? '搜索「' + q + '」：本页是静态预览，未接 /api/v1/search' : '')
        }
        onTheme={() => setTheme(toggleTheme())}
        theme={theme}
      />

      <main className='mx-auto w-full max-w-[72rem] px-5 pb-24 sm:px-8'>
        <div className='max-w-[64rem]'>
          <div className='border-b border-border pt-12 pb-7 sm:pt-16'>
            <h1 className='text-[30px] leading-tight font-semibold tracking-[-0.02em] text-foreground sm:text-[34px]'>
              最新主题
            </h1>
            <p className='mt-3 text-[15px] leading-relaxed text-muted-foreground'>
              来自 {BOARDS.length - 1} 个版块的讨论、资源与转载，按最后回复时间排序。
            </p>
          </div>

          {/* 演示开关：三个列表态各看一次；真接口下这些状态由响应决定 */}
          <div className='flex flex-wrap items-center gap-2 pt-6'>
            <span className='mr-1 text-[13px] text-muted-foreground'>预览状态</span>
            <Button className='h-8 px-3.5 text-[13px]' onClick={reload}>
              正常列表
            </Button>
            <Button
              onClick={() => {
                mode.current = 'empty';
                cursorRef.current = null;
                setCursor(null);
                setList([]);
                setState('empty');
              }}
              className='h-8 px-3.5 text-[13px]'
            >
              空状态
            </Button>
          </div>

          {notice ? (
            <p
              aria-live='polite'
              className='mt-5 rounded-md bg-muted px-4 py-3 text-[13px] text-muted-foreground'
            >
              {notice}
            </p>
          ) : null}

          <section aria-busy={state === 'loading'} aria-label='主题列表' className='mt-4'>
            {state === 'loading' ? (
              <>
                <span className='sr-only'>正在加载主题…</span>
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </>
            ) : null}

            {state === 'empty' ? (
              <div className='flex flex-col items-center gap-4 py-28 text-center'>
                <span className='rounded-full bg-muted p-4 text-muted-foreground'>
                  <Inbox aria-hidden className='size-7' />
                </span>
                <h2 className='text-[20px] font-semibold text-foreground'>这个版块还没有主题</h2>
                <p className='max-w-[26rem] text-[14px] leading-relaxed text-muted-foreground'>
                  第一个发帖的人会占住这里的位置。写点什么，排版交给编辑器。
                </p>
                <a
                  className='rounded-md bg-primary px-5 py-2.5 text-[14px] font-semibold text-primary-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  href='#new'
                >
                  发布第一个主题
                </a>
              </div>
            ) : null}

            {list.map((t) => (
              <TopicRow key={t.id} now={now} topic={t} />
            ))}

            {state === 'error' ? (
              <div className='flex flex-col items-start gap-3 border-t border-border py-16' role='alert'>
                <span className='flex items-center gap-2 text-[16px] font-semibold text-foreground'>
                  <CircleAlert aria-hidden className='size-5 text-destructive' />
                  列表没能加载出来
                </span>
                <p className='text-[14px] text-muted-foreground'>
                  网络断了，或者服务端暂时不可用（错误码 common.internal）。已加载的内容不会丢。
                </p>
                <Button className='h-8 px-3.5 text-[13px]' onClick={reload}>
                  <RefreshCw aria-hidden className='size-4' />
                  重试
                </Button>
              </div>
            ) : null}
          </section>

          <div className='h-px' ref={sentinel} />

          {state === 'more' ? (
            <p aria-live='polite' className='py-10 text-center text-[13px] text-muted-foreground'>
              正在加载更多…
            </p>
          ) : null}

          {state === 'ready' && cursor ? (
            <div className='flex justify-center pt-10'>
              <Button
                onClick={() => {
                  mode.current = 'more';
                  void acquire();
                }}
                className='h-11 px-6 text-[15px]'
              >
                <ArrowUp aria-hidden className='size-4 rotate-180' />
                加载更多
              </Button>
            </div>
          ) : null}

          {state === 'ready' && !cursor ? (
            <p className='flex items-center justify-center gap-2 pt-12 pb-2 text-[13px] text-muted-foreground'>
              <Check aria-hidden className='size-4' />
              已经到底了 · 共 {list.length} 条
            </p>
          ) : null}
        </div>
      </main>

      <footer className='border-t border-border'>
        <div className='mx-auto flex max-w-[72rem] flex-wrap items-center justify-between gap-3 px-5 py-8 text-[13px] text-muted-foreground sm:px-8'>
          <span>SC2clud · 星际争霸 II 中文社区</span>
          <span className='flex items-center gap-2'>
            <Sparkles aria-hidden className='size-4' />
            方向 B / v1 内容优先
          </span>
        </div>
      </footer>
    </div>
  );
}
