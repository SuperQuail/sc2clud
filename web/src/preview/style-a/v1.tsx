// 方向 A / v1「工作台」：双行紧凑行 + 右侧信息栏。
// 密度目标：1080p 一屏 12 条以上。靠列对齐、统一图标、三种功能标记（类型 / 置顶 / 精华）实现扫读；
// 不用卡片、不用阴影、不留大圆角 —— 装饰越少，同样像素里能放的信息越多。
// 数据形状照抄后端方案 §21.3 的主题列表项；预览不连网，封面图用本目录内的 SVG 占位（真实数据是 /img/<hash>）。
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Eye, Inbox, MessageSquare, Moon, Pin, Search, Star, Sun, ThumbsUp, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { formatTime } from '@/lib/format';
import { currentTheme, toggleTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Input } from '@/ui/input';
import coverCampaign from './cover-campaign.svg';
import coverMap from './cover-map.svg';
import coverTool from './cover-tool.svg';

type Kind = 'discussion' | 'resource' | 'repost';
type Board = { slug: string; name: string; count: number };
type Author = { handle: string; nickname: string; avatar: string };
type Topic = {
  id: string; board: Board; kind: Kind; title: string; author: Author;
  reply_count: number; like_count: number; view_count: number;
  featured_at: string | null; pinned: boolean; created_at: string; last_reply_at: string; cover: string;
};

const BOARDS = {
  all: { slug: 'all', name: '全部', count: 1384 },
  campaign: { slug: 'campaign', name: '自制战役', count: 412 },
  map: { slug: 'map', name: '地图开发', count: 236 },
  trigger: { slug: 'trigger', name: '触发器与数据', count: 301 },
  art: { slug: 'art', name: '模型与美术', count: 118 },
  tool: { slug: 'tool', name: '工具与插件', count: 97 },
  help: { slug: 'help', name: '提问求助', count: 208 },
  news: { slug: 'news', name: '公告', count: 12 },
} satisfies Record<string, Board>;

const AUTHORS = {
  tang: { handle: 'tangtian', nickname: '唐天', avatar: coverCampaign },
  lin: { handle: 'linq', nickname: '林奇', avatar: coverTool },
  an: { handle: 'anan', nickname: '阿南', avatar: coverMap },
  yue: { handle: 'yueying', nickname: '月影', avatar: '' },
  mo: { handle: 'moxi', nickname: '墨汐', avatar: '' },
  ke: { handle: 'kexue', nickname: '柯雪', avatar: '' },
  zhou: { handle: 'zhouyu', nickname: '周瑜', avatar: '' },
} satisfies Record<string, Author>;

const KIND_LABEL: Record<Kind, string> = { discussion: '讨论', resource: '资源', repost: '转载' };
const KIND_CLASS: Record<Kind, string> = {
  discussion: 'border-border text-muted-foreground',
  resource: 'border-primary/40 bg-primary/5 text-primary',
  repost: 'border-border bg-muted text-foreground/80',
};

// 一行一条，省下的行数用来看列表而不是看数据
type Draft = {
  kind: Kind; title: string; board: keyof typeof BOARDS; author: keyof typeof AUTHORS;
  reply: number; like: number; view: number; ago: number; born: number;
  cover?: string; pinned?: boolean; featured?: boolean;
};

const DRAFTS: Draft[] = [
  { kind: 'resource', title: '《艾尔的余烬》第三章发布：18 张地图 + 全新单位线', board: 'campaign', author: 'tang', reply: 326, like: 148, view: 12480, ago: 7, born: 4320, cover: coverCampaign, pinned: true },
  { kind: 'discussion', title: '关于资源帖审核与转载授权的规则（2026 修订）', board: 'news', author: 'tang', reply: 42, like: 96, view: 5210, ago: 51, born: 20000, pinned: true },
  { kind: 'resource', title: '触发器模板库 v2：37 个可直接拖进地图的 AI 波次模块', board: 'trigger', author: 'lin', reply: 88, like: 61, view: 4302, ago: 96, born: 9000, cover: coverTool, featured: true },
  { kind: 'discussion', title: '数据编辑器里给单位加自定义武器，为什么射程永远按默认值走？', board: 'trigger', author: 'yue', reply: 24, like: 9, view: 1502, ago: 132, born: 700 },
  { kind: 'resource', title: '战役地图亮度与雾效预设包（11 个预置，含沙漠与虚空夜）', board: 'art', author: 'an', reply: 57, like: 44, view: 3390, ago: 188, born: 6000, cover: coverMap, featured: true },
  { kind: 'repost', title: '[转载] 官方 Mod 工具链 2026 路线图要点翻译', board: 'news', author: 'mo', reply: 33, like: 27, view: 2860, ago: 240, born: 1200 },
  { kind: 'discussion', title: '一人做战役的排期经验：把美术外包和脚本拆开之后', board: 'campaign', author: 'ke', reply: 71, like: 52, view: 4108, ago: 305, born: 8800 },
  { kind: 'resource', title: '自制战役启动器 1.7.2：支持多存档槽与自动更新校验', board: 'tool', author: 'zhou', reply: 46, like: 38, view: 3612, ago: 366, born: 4400, cover: coverTool },
  { kind: 'discussion', title: 'Blender 导出 m3 之后贴图全黑，是哪一步漏了？', board: 'art', author: 'an', reply: 19, like: 6, view: 990, ago: 420, born: 300 },
  { kind: 'resource', title: '中文语音包（男声 / 女声）与字幕对齐脚本', board: 'art', author: 'yue', reply: 63, like: 49, view: 5230, ago: 512, born: 11000, cover: coverCampaign, featured: true },
  { kind: 'repost', title: '[转载] 韩国社区的自定义 UI 框架，附中文注释补丁', board: 'tool', author: 'lin', reply: 12, like: 8, view: 1180, ago: 640, born: 900 },
  { kind: 'discussion', title: '地图里 40 个单位以上就掉帧，有哪些低成本的优化手段？', board: 'map', author: 'ke', reply: 85, like: 31, view: 4720, ago: 700, born: 5200 },
  { kind: 'resource', title: '地形笔刷与装饰物包：雪原 / 熔岩 / 都市三套', board: 'map', author: 'mo', reply: 28, like: 22, view: 2110, ago: 823, born: 3300, cover: coverMap },
  { kind: 'discussion', title: '触发器里做存档兼容：老存档读新地图会不会直接崩？', board: 'trigger', author: 'zhou', reply: 37, like: 14, view: 1860, ago: 940, born: 2600 },
  { kind: 'resource', title: '战役过场动画模板：运镜 + 字幕 + 跳过逻辑都接好了', board: 'campaign', author: 'tang', reply: 54, like: 40, view: 3044, ago: 1080, born: 6600, cover: coverCampaign },
  { kind: 'discussion', title: '提问：多人合作地图怎么做掉线重连？', board: 'help', author: 'yue', reply: 16, like: 5, view: 780, ago: 1260, born: 400 },
];

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const TOPICS: Topic[] = DRAFTS.map((d, i) => ({
  id: '0192f0' + (100000 + i).toString(16) + 'a4',
  board: BOARDS[d.board],
  kind: d.kind,
  title: d.title,
  author: AUTHORS[d.author],
  reply_count: d.reply,
  like_count: d.like,
  view_count: d.view,
  featured_at: d.featured ? minsAgo(d.ago + 720) : null,
  pinned: d.pinned === true,
  created_at: minsAgo(d.born),
  last_reply_at: minsAgo(d.ago),
  cover: d.cover ?? '',
}));

const HOT = [...TOPICS].sort((a, b) => b.reply_count - a.reply_count).slice(0, 5);
const SITE_STATS = [
  { label: '主题', value: '1,384' }, { label: '回复', value: '9,173' },
  { label: '成员', value: '1,402' }, { label: '今日在线', value: '87' },
];
const SORTS = [{ v: 'latest', label: '最新回复' }, { v: 'new', label: '最新发布' }, { v: 'hot', label: '热门' }] as const;
const VIEWS: { v: 'list' | 'loading' | 'empty' | 'error'; label: string }[] = [
  { v: 'list', label: '列表' }, { v: 'loading', label: '加载中' }, { v: 'empty', label: '空' }, { v: 'error', label: '错误' },
];
type SortKey = (typeof SORTS)[number]['v'];
type View = (typeof VIEWS)[number]['v'];

const SKELETON = [0, 1, 2, 3, 4, 5, 6, 7];
const PANEL = 'rounded-md border border-border bg-card';
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PAGE_CURSOR = 'eyJrIjoxNzYwMjQsImlkIjoiMDE5MmYwMTg2YTRhNCJ9';

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  return (n / 10000).toFixed(1) + '万';
}

function KindBadge({ kind }: { kind: Kind }) {
  return <span className={cn('shrink-0 rounded-sm border px-1 text-[11px] leading-4', KIND_CLASS[kind])}>{KIND_LABEL[kind]}</span>;
}

function Avatar({ author, className }: { author: Author; className?: string }) {
  const base = 'flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground';
  if (!author.avatar) return <span aria-hidden className={cn(base, className)}>{author.nickname.slice(0, 1)}</span>;
  return <img src={author.avatar} alt={author.nickname + ' 的头像'} width={16} height={16} loading="lazy" className={cn(base, 'object-cover', className)} />;
}

// 数字列：视觉上只留图标 + 数字，指标名交给读屏（列表里重复 15 遍「回复 12」是噪声）
function Stat({ icon: Icon, value, label, className }: { icon: typeof Eye; value: number; label: string; className?: string }) {
  return (
    <span className={cn('flex items-center gap-1', className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span aria-hidden className="tabular-nums">{formatCount(value)}</span>
      <span className="sr-only">{label} {value}</span>
    </span>
  );
}

function TopicRow({ topic }: { topic: Topic }) {
  const featured = topic.featured_at !== null;
  return (
    <li className={cn('group relative border-b border-border transition-colors group-hover:bg-muted/50', topic.pinned && 'bg-muted/40')}>
      <div className="flex items-start gap-2.5 px-1.5 py-2">
        <span className="mt-1 flex w-3.5 shrink-0 justify-center">
          {topic.pinned ? <Pin aria-hidden className="size-3.5 fill-primary text-primary" /> : featured ? <Star aria-hidden className="size-3.5 text-muted-foreground" /> : null}
        </span>
        <span className="hidden shrink-0 sm:block">
          {topic.cover ? (
            <img src={topic.cover} alt={topic.title + ' 的封面'} width={56} height={40} loading="lazy" className="h-10 w-14 rounded-sm border border-border object-cover" />
          ) : (
            <span aria-hidden className="block h-10 w-14 rounded-sm border border-dashed border-border/70" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <KindBadge kind={topic.kind} />
            {topic.pinned || featured ? (
              <span className={cn('shrink-0 rounded-sm border px-1 text-[11px] leading-4', topic.pinned ? 'border-primary/40 text-primary' : 'border-border bg-muted text-foreground/80')}>
                {topic.pinned ? '置顶' : '精华'}
              </span>
            ) : null}
            <h3 className="min-w-0 text-[14px] leading-6 font-medium">
              <a href={'#/t/' + topic.id} className={cn(FOCUS, 'block truncate text-foreground after:absolute after:inset-0 hover:text-primary hover:underline')}>
                {topic.title}
              </a>
            </h3>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1">
              <Avatar author={topic.author} className="size-4 text-[10px]" />
              <span className="truncate">{topic.author.nickname}</span>
            </span>
            <span aria-hidden>·</span>
            <a href={'#/b/' + topic.board.slug} className={cn(FOCUS, 'relative z-10 shrink-0 hover:text-foreground')}>{topic.board.name}</a>
            <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums md:hidden">
              <Stat icon={MessageSquare} value={topic.reply_count} label="回复" />
              <Stat icon={ThumbsUp} value={topic.like_count} label="赞" />
              <Stat icon={Eye} value={topic.view_count} label="浏览" />
              <time dateTime={topic.last_reply_at}>{formatTime(topic.last_reply_at)}</time>
            </span>
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-3 pt-1 text-[12px] text-muted-foreground tabular-nums md:flex">
          <Stat icon={MessageSquare} value={topic.reply_count} label="回复" className="w-11 justify-end" />
          <Stat icon={ThumbsUp} value={topic.like_count} label="赞" className="w-9 justify-end" />
          <Stat icon={Eye} value={topic.view_count} label="浏览" className="w-12 justify-end" />
          <time className="w-16 text-right" dateTime={topic.last_reply_at}>{formatTime(topic.last_reply_at)}</time>
        </div>
      </div>
    </li>
  );
}

function SkeletonRows() {
  return (
    <ul aria-busy="true" aria-live="polite" className="border-t border-border">
      <li className="sr-only">正在加载主题…</li>
      {SKELETON.map((k) => (
        <li key={k} className="flex items-center gap-2.5 border-b border-border px-1.5 py-2">
          <span className="size-3.5 shrink-0 animate-pulse rounded-sm bg-muted" />
          <span className="hidden h-10 w-14 shrink-0 animate-pulse rounded-sm bg-muted sm:block" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span className="block h-4 w-3/5 animate-pulse rounded-sm bg-muted" />
            <span className="block h-3 w-1/4 animate-pulse rounded-sm bg-muted" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1.5 border-t border-border px-4 py-16 text-center">
      <Inbox aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-[14px] font-medium">这个版块还没有主题</p>
      <p className="text-[12px] text-muted-foreground">换个版块看看，或者发第一个主题。</p>
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={onReset}>看全部版块</Button>
        <Button primary>发布主题</Button>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-1.5 border-t border-border px-4 py-16 text-center">
      <TriangleAlert aria-hidden className="size-6 text-destructive" />
      <p className="text-[14px] font-medium">主题列表加载失败</p>
      <p className="text-[12px] text-muted-foreground">服务器错误，稍后重试即可。</p>
      <p className="text-[11px] text-muted-foreground">common.internal · 请求编号 req_9f3c1a72</p>
      <Button className="mt-2" onClick={onRetry}>重试</Button>
    </div>
  );
}

export default function StyleAV1() {
  const [theme, setTheme] = useState(currentTheme);
  const [board, setBoard] = useState('all');
  const [sort, setSort] = useState<SortKey>('latest');
  const [view, setView] = useState<View>('list');
  const [cursor, setCursor] = useState<string | null>(PAGE_CURSOR);
  const [loadingMore, setLoadingMore] = useState(false);
  // 游标分页：cursor 非空 = 还有下一页（后端方案 §21.1，禁止 page/offset）
  const items = cursor ? TOPICS.slice(0, 10) : TOPICS;

  function loadMore() {
    setLoadingMore(true);
    window.setTimeout(() => {
      setLoadingMore(false);
      setCursor(null);
    }, 350);
  }

  return (
    <div className="min-h-screen bg-background text-foreground [--muted-foreground:color-mix(in_srgb,var(--foreground)_72%,transparent)]">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-11 max-w-[1440px] items-center gap-2 px-3">
          <a href="#/" className={cn(FOCUS, 'flex shrink-0 items-center gap-1.5 rounded-sm')}>
            <span className="grid size-5 place-items-center rounded-sm bg-primary text-[11px] font-bold text-primary-foreground">S2</span>
            <span className="text-[15px] font-semibold tracking-tight">SC2clud</span>
          </a>
          <nav aria-label="版块导航" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
            {Object.values(BOARDS).map((b) => (
              <a
                key={b.slug}
                href={b.slug === 'all' ? '#/' : '#/b/' + b.slug}
                aria-current={board === b.slug ? 'page' : undefined}
                onClick={() => setBoard(b.slug)}
                className={cn(FOCUS, 'shrink-0 rounded-sm px-2 py-0.5 text-[13px] whitespace-nowrap hover:bg-muted', board === b.slug ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground')}
              >
                {b.name}
              </a>
            ))}
          </nav>
          <form role="search" onSubmit={(e) => e.preventDefault()} className="relative hidden shrink-0 md:block">
            <label htmlFor="a1-q" className="sr-only">搜索主题</label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input id="a1-q" type="search" placeholder="搜索主题 / 作者" className="h-7 w-36 pl-7 text-[13px] transition-[width] focus:w-52" />
          </form>
          <button
            type="button"
            aria-pressed={theme === 'dark'}
            aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            onClick={() => setTheme(toggleTheme())}
            className={cn(FOCUS, 'grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted')}
          >
            {theme === 'dark' ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
          </button>
          <a href="#/u/tangtian" className={cn(FOCUS, 'flex shrink-0 items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-muted')}>
            <Avatar author={AUTHORS.tang} className="size-5 text-[11px]" />
            <span className="hidden text-[13px] sm:inline">唐天</span>
            <span className="rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
              <span className="sr-only">未读通知 </span>3
            </span>
          </a>
        </div>
        <div className="mx-auto flex h-8 max-w-[1440px] items-center gap-3 border-t border-border/60 px-3 text-[12px] text-muted-foreground">
          <div role="group" aria-label="排序" className="flex items-center gap-0.5">
            {SORTS.map((s) => (
              <button
                key={s.v}
                type="button"
                aria-pressed={sort === s.v}
                onClick={() => setSort(s.v)}
                className={cn(FOCUS, 'rounded-sm px-1.5 py-0.5', sort === s.v ? 'bg-muted font-semibold text-foreground' : 'hover:text-foreground')}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span aria-hidden className="hidden h-3 w-px bg-border sm:block" />
          <span className="hidden tabular-nums sm:inline">共 {BOARDS.all.count.toLocaleString('zh-CN')} 个主题</span>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="hidden lg:inline">预览状态</span>
            <div role="group" aria-label="预览状态" className="flex items-center gap-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v.v}
                  type="button"
                  aria-pressed={view === v.v}
                  onClick={() => setView(v.v)}
                  className={cn(FOCUS, 'rounded-sm border px-1.5 py-0.5', view === v.v ? 'border-border bg-muted font-semibold text-foreground' : 'border-transparent hover:text-foreground')}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <h1 className="sr-only">SC2clud 社区首页 · 主题信息流</h1>

      <div className="mx-auto grid max-w-[1440px] items-start gap-4 px-3 py-3 min-[1200px]:grid-cols-[minmax(0,1fr)_248px]">
        <main>
          {view === 'loading' ? <SkeletonRows /> : null}
          {view === 'empty' ? <EmptyState onReset={() => setView('list')} /> : null}
          {view === 'error' ? <ErrorState onRetry={() => setView('list')} /> : null}
          {view === 'list' ? (
            <>
              <ul className="border-t border-border">
                {items.map((t) => <TopicRow key={t.id} topic={t} />)}
              </ul>
              <div className="flex items-center justify-center gap-3 py-3 text-[12px] text-muted-foreground">
                {cursor ? (
                  <>
                    <Button loader={loadingMore} disabled={loadingMore} onClick={loadMore}>{loadingMore ? '加载中' : '加载更多'}</Button>
                    <span className="tabular-nums">已显示 {items.length} / {BOARDS.all.count.toLocaleString('zh-CN')}</span>
                  </>
                ) : (
                  <span className="tabular-nums">已经到底了 · 共 {TOPICS.length} 条</span>
                )}
              </div>
            </>
          ) : null}
        </main>

        <aside className="grid gap-3 md:grid-cols-3 min-[1200px]:grid-cols-1">
          <section className={cn(PANEL, 'p-2')}>
            <h2 className="mb-1 px-1 text-[12px] font-semibold text-muted-foreground">版块</h2>
            <ul>
              {Object.values(BOARDS).map((b) => (
                <li key={b.slug}>
                  <a
                    href={b.slug === 'all' ? '#/' : '#/b/' + b.slug}
                    className={cn(FOCUS, 'flex items-center justify-between rounded-sm px-1 py-1 text-[13px] hover:bg-muted', board === b.slug && 'font-semibold')}
                  >
                    <span className="truncate">{b.name}</span>
                    <span className="text-[12px] tabular-nums text-muted-foreground">{b.count}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section className={cn(PANEL, 'p-2')}>
            <h2 className="mb-1 px-1 text-[12px] font-semibold text-muted-foreground">今日热议</h2>
            <ol>
              {HOT.map((t, i) => (
                <li key={t.id} className="flex items-start gap-1.5 rounded-sm px-1 py-1 hover:bg-muted">
                  <span aria-hidden className={cn('w-3 shrink-0 text-center text-[11px] tabular-nums', i < 3 ? 'font-semibold text-primary' : 'text-muted-foreground')}>{i + 1}</span>
                  <a href={'#/t/' + t.id} className={cn(FOCUS, 'line-clamp-2 text-[12px] leading-5 hover:text-primary')}>{t.title}</a>
                </li>
              ))}
            </ol>
          </section>

          <section className={cn(PANEL, 'p-2')}>
            <h2 className="mb-1 px-1 text-[12px] font-semibold text-muted-foreground">站点</h2>
            <dl className="grid gap-y-1 px-1 text-[12px]">
              {SITE_STATS.map((s) => (
                <div key={s.label} className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">{s.label}</dt>
                  <dd className="tabular-nums">{s.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
