// 方向 C / v2「工具台」：分区头做成通栏 banner（name/简介压在封面上），左栏收成图标条 + 紧凑版块列表，
// 右侧一栏到底；默认紧凑视图用单行节奏（一屏 ~14 条），卡片视图 3 列（1440×900 下 6 张完整可见）。
// 与 v1 的差别：顶栏两行、分区头形态、导航是下划线标签（v1 是 Ring UI Tabs）、卡片 3 列（v1 是 2 列）、行高更紧。
// 控件同样全部来自 Ring UI；自建件在 shared.tsx 与文件末尾，标注「待提升为 src/ui」。
import Avatar from '@jetbrains/ring-ui-built/components/avatar/avatar';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonGroup from '@jetbrains/ring-ui-built/components/button-group/button-group';
import Dropdown from '@jetbrains/ring-ui-built/components/dropdown/dropdown';
import ErrorMessage from '@jetbrains/ring-ui-built/components/error-message/error-message';
import Input, { Size as InputSize } from '@jetbrains/ring-ui-built/components/input/input';
import Link from '@jetbrains/ring-ui-built/components/link/link';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Panel from '@jetbrains/ring-ui-built/components/panel/panel';
import PopupMenu from '@jetbrains/ring-ui-built/components/popup-menu/popup-menu';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { Bell, ChevronDown, Hash, Pin, Search, Star, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { formatTime } from '@/lib/format';
import { currentTheme, toggleTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import {
  BOARDS, BOARD_LIST, BOARD_STATS, SORTS, TABS, boardHref, filterTopics, fmt, topicHref,
  type Board, type BoardTab, type Topic,
} from './data';
import { KindTag, Like, Pager, Reply, View, ViewToggle, useFeed, useUrlState, useViewMode } from './shared';

const TOKENS = '[--muted-foreground:color-mix(in_srgb,var(--foreground)_74%,transparent)]';
const AVATAR_STYLE = { border: '1px solid var(--border)' } as const;
const PIN_ICON = <Pin aria-hidden className="size-3.5 shrink-0 text-primary" />;
const FEAT_ICON = <Star aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;

// ——— 左栏：图标条 + 紧凑版块列表（窄屏收成顶部下拉，见 BoardPicker）———
function Rail({ active, onPick }: { active: string; onPick: (slug: string) => void }) {
  return (
    <nav aria-label="版块导航" className="flex w-44 shrink-0 flex-col overflow-y-auto border-r border-border bg-card">
      <Link href="#/" className="flex items-center gap-1.5 border-b border-border px-2.5 py-2 text-[13px] font-semibold no-underline">
        <Hash aria-hidden className="size-3.5 text-primary" />
        SC2clud
      </Link>
      <ul className="flex flex-col py-1">
        {BOARD_LIST.map((b) => {
          const on = b.slug === active;
          return (
            <li key={b.slug}>
              <Link
                href={boardHref(b.slug)}
                onClick={() => onPick(b.slug)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 border-l-2 py-1 pr-2 pl-2.5 no-underline',
                  on ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-transparent text-foreground hover:bg-muted',
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[12px]">{b.name}</span>
                {b.today_count > 0 ? <span className="shrink-0 text-[10px] text-primary tabular-nums">+{b.today_count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto border-t border-border p-1.5">
        <Link href="#/boards" className="block rounded-sm px-1.5 py-1 text-[11px] no-underline hover:bg-muted">
          全部版块
        </Link>
      </div>
    </nav>
  );
}

// 窄屏（<1200）没有左栏：用一个下拉换版块（Dropdown + PopupMenu 都是 Ring UI，键盘行为由它负责）
function BoardPicker({ active, onPick }: { active: string; onPick: (slug: string) => void }) {
  const current = BOARDS[active] ?? BOARDS['campaign'];
  return (
    <Dropdown
      anchor={
        <Button icon={Hash} className="lg:hidden">
          {current?.name ?? '版块'}
          <ChevronDown aria-hidden className="ml-1 size-3.5" />
        </Button>
      }
    >
      <PopupMenu
        data={BOARD_LIST.map((b) => ({ key: b.slug, label: b.name + ' · ' + fmt(b.topic_count) }))}
        onSelect={(item) => onPick(String((item as { key: string }).key))}
        closeOnSelect
      />
    </Dropdown>
  );
}

// ——— 分区头：通栏 banner，名称与简介压在封面上 ———
function Hero({
  board, joined, onJoinToggle, query, onQuery, picker,
}: {
  board: Board; joined: boolean; onJoinToggle: () => void; query: string; onQuery: (q: string) => void; picker: React.ReactNode;
}) {
  return (
    <header className="relative">
      <div className="relative h-24 overflow-hidden border-b border-border sm:h-28">
        <img src={board.cover} alt="" className="size-full object-cover" />
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(to_top,var(--background),transparent_70%)]" />
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end gap-x-2 gap-y-1 px-3 sm:px-4">
          <h1 className="text-[22px] leading-8 font-semibold">{board.name}</h1>
          <span className="pb-1 text-[11px] text-muted-foreground">/{board.slug}</span>
          {joined ? <Tag readOnly tagType={TagType.SUCCESS} className="mb-1">已关注</Tag> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card px-3 py-2 sm:px-4">
        {picker}
        <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{board.description}</p>
        <dl className="grid w-full shrink-0 grid-cols-4 gap-x-3 text-[12px] text-muted-foreground tabular-nums sm:w-auto">
          {BOARD_STATS(board).map((s) => (
            <div key={s.label} className="flex items-baseline gap-1">
              <dt className="text-[11px]">{s.label}</dt>
              <dd className="text-[12px] font-medium text-foreground">{s.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            size={InputSize.M}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="版块内搜索"
            aria-label="版块内搜索"
            icon={Search}
            className="w-28 shrink sm:w-44"
          />
          <Button primary={!joined} onClick={onJoinToggle} aria-pressed={joined}>
            {joined ? '取消关注' : '+ 关注'}
          </Button>
          <Button primary={joined}>发帖</Button>
        </div>
      </div>
    </header>
  );
}

// ——— 下划线标签导航（当前选中：底部 2px 主色条 + 字重）———
function TabBar({ tab, onTab }: { tab: BoardTab; onTab: (t: BoardTab) => void }) {
  return (
    <div role="tablist" aria-label="分区内导航" className="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-card px-2 sm:px-3">
      {TABS.map((t) => {
        const on = t.key === tab;
        return (
          <Button
            key={t.key}
            role="tab"
            aria-selected={on}
            active={on}
            onClick={() => onTab(t.key)}
            className={cn('rounded-none border-b-2', on ? 'border-primary' : 'border-transparent')}
          >
            {t.label}
          </Button>
        );
      })}
    </div>
  );
}

// ——— 紧凑行（默认视图）：单行节奏，hover 整行底色，无分隔线 ———
function TopicLine({ topic }: { topic: Topic }) {
  return (
    <li className="group relative flex items-center gap-2 rounded-sm py-1 pr-2 pl-1.5 hover:bg-muted/60">
      <span aria-hidden className="flex w-3 shrink-0 justify-center">
        {topic.pinned ? PIN_ICON : topic.featured === true ? FEAT_ICON : null}
      </span>
      <Avatar
        url={topic.author.avatar || null}
        username={topic.author.nickname}
        size={24}
        round
        style={AVATAR_STYLE}
        alt={topic.author.nickname + ' 的头像'}
        className="shrink-0"
      />
      <KindTag kind={topic.kind} className="shrink-0" />
      <h3 className="min-w-0 flex-1 truncate text-[13px] leading-6 font-normal">
        <Link inherit href={topicHref(topic.id)} className="text-foreground after:absolute after:inset-0">
          {topic.title}
        </Link>
      </h3>
      <span className="hidden shrink-0 items-baseline gap-1.5 text-[11px] whitespace-nowrap text-muted-foreground sm:flex">
        <Link inherit href={'#/u/' + topic.author.handle} className="relative z-10 text-muted-foreground">
          {topic.author.nickname}
        </Link>
        <span aria-hidden>·</span>
        <time dateTime={topic.last_reply_at}>{formatTime(topic.last_reply_at)}</time>
      </span>
      <span className="hidden shrink-0 items-center gap-2 text-[11px] whitespace-nowrap text-muted-foreground md:flex">
        <Reply value={topic.reply_count} className="w-10 justify-end" />
        <Like value={topic.like_count} className="w-9 justify-end" />
        <View value={topic.view_count} className="w-12 justify-end" />
      </span>
    </li>
  );
}

function TopicCard({ topic }: { topic: Topic }) {
  return (
    <Panel className="relative flex flex-col overflow-hidden p-0">
      {topic.cover === undefined ? (
        <div aria-hidden className="h-36 w-full border-b border-border bg-[repeating-linear-gradient(45deg,var(--muted)_0_8px,transparent_8px_16px)]" />
      ) : (
        <img src={topic.cover} alt="" width={640} height={360} loading="lazy" className="h-36 w-full border-b border-border object-cover" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        <div className="flex flex-wrap items-center gap-1">
          <KindTag kind={topic.kind} />
          {topic.pinned ? <Tag readOnly tagType={TagType.MAIN}>置顶</Tag> : null}
          {topic.featured === true ? <Tag readOnly tagType={TagType.WARNING}>精华</Tag> : null}
        </div>
        <h3 className="line-clamp-2 text-[14px] leading-5 font-medium">
          <Link inherit href={topicHref(topic.id)} className="text-foreground after:absolute after:inset-0">
            {topic.title}
          </Link>
        </h3>
        <p className="line-clamp-1 text-[12px] text-muted-foreground">{topic.excerpt}</p>
        <div className="mt-auto flex items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
          <Avatar
            url={topic.author.avatar || null}
            username={topic.author.nickname}
            size={16}
            round
            style={AVATAR_STYLE}
            alt={topic.author.nickname + ' 的头像'}
          />
          <Link inherit href={'#/u/' + topic.author.handle} className="relative z-10 truncate text-muted-foreground">
            {topic.author.nickname}
          </Link>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
            <Reply value={topic.reply_count} />
            <Like value={topic.like_count} />
            <View value={topic.view_count} />
            <time dateTime={topic.last_reply_at}>{formatTime(topic.last_reply_at)}</time>
          </span>
        </div>
      </div>
    </Panel>
  );
}

function Skeleton({ card }: { card: boolean }) {
  const cells = card ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  return (
    <ul aria-busy="true" aria-live="polite" className={card ? 'grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3' : 'flex flex-col gap-0.5'}>
      <li className="col-span-full flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
        <LoaderInline aria-hidden />
        正在加载主题…
      </li>
      {cells.map((k) => (
        <li key={k} className={card ? 'rounded-sm border border-border p-2.5' : 'flex items-center gap-2 py-1.5'}>
          <span className={card ? 'block' : 'contents'}>
            <span className={cn('block animate-pulse rounded-sm bg-muted', card ? 'aspect-video w-full' : 'size-6 shrink-0 rounded-full')} />
            <span className={cn('block space-y-1.5', card ? 'mt-2' : 'min-w-0 flex-1')}>
              <span className="block h-3.5 w-2/3 animate-pulse rounded-sm bg-muted" />
              <span className="block h-3 w-1/3 animate-pulse rounded-sm bg-muted" />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-14 text-center">
      <p className="text-[14px] font-medium">这个标签下还没有主题</p>
      <p className="text-[12px] text-muted-foreground">换个标签，或者发第一个主题。</p>
      <ButtonGroup className="mt-2">
        <Button>看全部主题</Button>
        <Button primary>发布主题</Button>
      </ButtonGroup>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12">
      <ErrorMessage icon={TriangleAlert} message="主题列表加载失败" description="请求超时，请检查网络后重试。" />
      <Button onClick={onRetry}>重试</Button>
    </div>
  );
}

const STATES = [
  { key: 'list', label: '列表' },
  { key: 'loading', label: '加载中' },
  { key: 'empty', label: '空' },
  { key: 'error', label: '错误' },
] as const;

export default function BoardPageV2() {
  const [slug, setSlug] = useUrlState('board', 'campaign');
  const [tab, setTab] = useUrlState('tab', 'all');
  const [sort, setSort] = useState('last_reply');
  const [query, setQuery] = useState('');
  const [joined, setJoined] = useState(true);
  const [demo, setDemo] = useState<(typeof STATES)[number]['key']>('list'); // 预览开关，不是产品功能
  const [mode, setMode] = useViewMode();
  const feed = useFeed();

  const board = BOARDS[slug] ?? BOARDS['campaign'];
  if (board === undefined) throw new Error('假数据缺少 campaign 版块');
  const all = filterTopics(board, tab as BoardTab);
  const loading = demo === 'loading';
  const items = loading || demo === 'error' || demo === 'empty' ? [] : all.slice(0, feed.items.length);
  const sortLabel = SORTS.find((s) => s.key === sort)?.label ?? '最新回复';

  return (
    <div className={cn('flex min-h-screen w-full flex-col overflow-x-hidden bg-background text-foreground', TOKENS)}>
      <header className="sticky top-0 z-30 flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2.5">
        <Link href="#/" className="text-[13px] font-semibold no-underline">
          SC2clud
        </Link>
        <nav aria-label="站点导航" className="hidden items-center gap-2.5 text-[12px] sm:flex">
          <Link href="#/boards">版块</Link>
          <Link href="#/latest">最新</Link>
          <Link href="#/launcher">启动器</Link>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Input size={InputSize.S} placeholder="搜索全站" aria-label="搜索全站" icon={Search} className="hidden md:flex" />
          <Button icon={Bell} title="通知" aria-label="通知" />
          <Button onClick={() => toggleTheme()}>{currentTheme() === 'dark' ? '浅色' : '深色'}</Button>
        </div>
      </header>
      <div className="sticky top-9 z-20 flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
        <Link href="#/boards">版块</Link>
        <span aria-hidden>/</span>
        <span className="text-foreground">{board.name}</span>
        <span aria-hidden>/</span>
        <span>{TABS.find((t) => t.key === tab)?.label ?? '全部'}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="hidden sm:inline">预览状态</span>
          {STATES.map((s) => (
            <Button key={s.key} active={demo === s.key} aria-pressed={demo === s.key} onClick={() => setDemo(s.key)}>
              {s.label}
            </Button>
          ))}
        </span>
      </div>

      <div className="flex flex-1 items-start">
        <div className="sticky top-15 hidden max-h-[calc(100vh-3.75rem)] lg:flex">
          <Rail active={board.slug} onPick={(s) => setSlug(s)} />
        </div>
        <main className="flex min-w-0 flex-1 flex-col">
          <Hero
            board={board}
            joined={joined}
            onJoinToggle={() => setJoined(!joined)}
            query={query}
            onQuery={setQuery}
            picker={<BoardPicker active={board.slug} onPick={(s) => setSlug(s)} />}
          />
          <TabBar tab={tab as BoardTab} onTab={setTab} />
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
            {query.trim() === '' ? null : (
              <Tag readOnly tagType={TagType.DEFAULT} onRemove={() => setQuery('')}>
                {'搜索：' + query}
              </Tag>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Dropdown
                anchor={
                  <Button>
                    {sortLabel}
                    <ChevronDown aria-hidden className="ml-1 size-3.5" />
                  </Button>
                }
              >
                <PopupMenu
                  data={SORTS.map((s) => ({ key: s.key, label: s.label }))}
                  onSelect={(item) => setSort(String((item as { key: string }).key))}
                  closeOnSelect
                />
              </Dropdown>
              <ViewToggle mode={mode} onChange={setMode} label />
            </div>
          </div>

          <div className="px-2.5 pt-1.5 pb-8">
            {demo === 'error' ? (
              <ErrorState onRetry={() => setDemo('list')} />
            ) : demo === 'empty' ? (
              <EmptyState />
            ) : (
              <>
                {loading ? <Skeleton card={mode === 'card'} /> : null}
                {!loading && mode === 'compact' ? (
                  <ul className="flex flex-col gap-0.5">
                    {items.map((t) => (
                      <TopicLine key={t.id} topic={t} />
                    ))}
                  </ul>
                ) : null}
                {!loading && mode === 'card' ? (
                  <ul className="grid auto-rows-min grid-cols-1 items-start gap-2 md:grid-cols-2 lg:grid-cols-3">
                    {[...items].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map((t) => (
                      <li key={t.id}>
                        <TopicCard topic={t} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {demo === 'list' ? <Pager feed={feed} shown={items.length} total={all.length} className="mt-2" /> : null}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  预览：{mode === 'compact' ? '紧凑视图' : '卡片视图'} · ?view={mode} 由 URL 记住，1 / 2 键可切换 · 共 {fmt(all.length)} 个主题
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
