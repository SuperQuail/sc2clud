// 方向 C / v1「常驻左栏」：贴吧血统最直白的一版 —— 左栏常驻版块列表，右侧分区头 + 密集帖子流。
// 默认落在紧凑视图（一屏 ~8 条）；卡片视图是 2 列可选项（1440×900 下完整可见 4 张）。
// 控件：Ring UI（Button / ButtonGroup / Input / Tabs / Avatar / Tag / Link / Panel / ErrorMessage / LoaderInline / Dialog / Banner）。
// 自建件都在本目录 shared.tsx 与文件末尾，标注「待提升为 src/ui」。
import Avatar from '@jetbrains/ring-ui-built/components/avatar/avatar';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonGroup from '@jetbrains/ring-ui-built/components/button-group/button-group';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import ErrorMessage from '@jetbrains/ring-ui-built/components/error-message/error-message';
import Input, { Size as InputSize } from '@jetbrains/ring-ui-built/components/input/input';
import Link from '@jetbrains/ring-ui-built/components/link/link';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Panel from '@jetbrains/ring-ui-built/components/panel/panel';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { Eye, LayoutList, MessageSquare, PanelLeft, Pin, Search, Star, ThumbsUp, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { formatTime } from '@/lib/format';
import { currentTheme, toggleTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import {
  BOARDS, BOARD_LIST, BOARD_STATS, SORTS, TABS, boardHref, filterTopics, fmt, topicHref,
  type Board, type BoardTab, type Topic,
} from './data';
import { KindTag, Like, Pager, Reply, View, ViewToggle, useFeed, useUrlState, useViewMode } from './shared';

// 11–12px 的弱化文字在浅色下要够 4.5:1：令牌里的 62% 混色压线，容器内提到 74%（不改全局令牌）
const TOKENS = '[--muted-foreground:color-mix(in_srgb,var(--foreground)_74%,transparent)]';

const PIN_ICON = <Pin aria-hidden className="size-3.5 shrink-0 text-primary" />;
const FEAT_ICON = <Star aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
const AVATAR_STYLE = { border: '1px solid var(--border)' } as const;

// ——— 版块列表（左栏与 <1200 的抽屉共用同一份）———
function BoardList({ active, onPick }: { active: string; onPick: (slug: string) => void }) {
  return (
    <nav aria-label="版块列表" className="flex flex-col gap-0.5 p-1.5">
      {BOARD_LIST.map((b) => {
        const on = b.slug === active;
        return (
          <Link
            key={b.slug}
            href={boardHref(b.slug)}
            onClick={() => onPick(b.slug)}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-sm px-2 py-1.5 no-underline',
              on ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-[13px]">{b.name}</span>
            {b.today_count > 0 ? <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{b.today_count} 新</span> : null}
            <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{fmt(b.topic_count)}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function BoardSidebar({ active, onPick }: { active: string; onPick: (slug: string) => void }) {
  return (
    <aside aria-label="版块导航" className="sticky top-12 max-h-[calc(100vh-3rem)] overflow-y-auto border-r border-border bg-card">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-[12px] font-medium tracking-wide text-muted-foreground">版块</h2>
      </div>
      <BoardList active={active} onPick={onPick} />
      <div className="border-t border-border p-2">
        <Link href="#/new" className="block rounded-sm px-2 py-1.5 text-[12px] no-underline hover:bg-muted">
          全站最新主题
        </Link>
        <Link href="#/boards" className="block rounded-sm px-2 py-1.5 text-[12px] no-underline hover:bg-muted">
          全部版块索引
        </Link>
      </div>
    </aside>
  );
}

// <1200 时左栏收进抽屉；用的是 Ring UI 的 Dialog（焦点陷阱与 Esc 由它负责）
function BoardDrawer({ open, active, onPick, onClose }: { open: boolean; active: string; onPick: (slug: string) => void; onClose: () => void }) {
  return (
    <Dialog label="版块列表" show={open} onCloseAttempt={onClose} contentClassName="board-drawer">
      <p className="px-3 pt-2 pb-1 text-[12px] font-medium text-muted-foreground">版块</p>
      <BoardList active={active} onPick={onPick} />
    </Dialog>
  );
}

// ——— 分区头：名称 / 简介 / 统计 / 关注 / 发帖 / 站内搜索 / 标签导航 ———
function BoardHeader({
  board, tab, onTab, joined, onJoinToggle, onOpenBoards, query, onQuery, onPosted,
}: {
  board: Board; tab: BoardTab; onTab: (t: BoardTab) => void; joined: boolean; onJoinToggle: () => void;
  onOpenBoards: () => void; query: string; onQuery: (q: string) => void; onPosted: () => void;
}) {
  return (
    <header className="border-b border-border bg-card">
      <div className="flex gap-3 px-3 py-3 sm:px-4">
        <img
          src={board.cover}
          alt=""
          width={88}
          height={88}
          className="hidden size-22 shrink-0 rounded-sm border border-border object-cover sm:block"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Button icon={PanelLeft} className="lg:hidden" onClick={onOpenBoards}>
              版块
            </Button>
            <h1 className="text-[20px] leading-7 font-semibold">{board.name}</h1>
            <Tag readOnly tagType={TagType.DEFAULT} className="hidden sm:inline-flex">
              {board.slug}
            </Tag>
            {joined ? <Tag readOnly tagType={TagType.SUCCESS}>已关注</Tag> : null}
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{board.description}</p>
          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted-foreground tabular-nums sm:flex sm:flex-wrap sm:gap-x-5">
            {BOARD_STATS(board).map((s) => (
              <div key={s.label} className="flex items-baseline gap-1.5">
                <dt>{s.label}</dt>
                <dd className="text-[13px] font-medium text-foreground">{s.value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button primary={!joined} onClick={onJoinToggle} aria-pressed={joined}>
              {joined ? '取消关注' : '+ 关注'}
            </Button>
            <Button onClick={onPosted}>发帖</Button>
            <Input
              size={InputSize.M}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="在版块内搜索"
              aria-label="在版块内搜索"
              icon={Search}
              className="w-full sm:ml-auto sm:w-56"
            />
          </div>
        </div>
      </div>
      <Tabs
        className="px-3 sm:px-4"
        selected={tab}
        onSelect={(key) => () => onTab(key as BoardTab)}
      >
        {TABS.map((t) => (
          <Tab key={t.key} id={t.key} title={t.label} />
        ))}
      </Tabs>
    </header>
  );
}

// ——— 帖子流 ———
function TopicRow({ topic }: { topic: Topic }) {
  const badge = topic.pinned ? '置顶' : topic.featured === true ? '精华' : '';
  return (
    <li className="group relative flex items-start gap-2.5 rounded-sm px-1.5 py-1.5 hover:bg-muted/60">
      <span aria-hidden className="mt-1 flex w-3.5 shrink-0 justify-center">
        {topic.pinned ? PIN_ICON : topic.featured === true ? FEAT_ICON : null}
      </span>
      <Avatar
        url={topic.author.avatar || null}
        username={topic.author.nickname}
        size={28}
        round
        style={AVATAR_STYLE}
        alt={topic.author.nickname + ' 的头像'}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <KindTag kind={topic.kind} />
          {badge !== '' ? <span className="shrink-0 text-[11px] text-primary">{badge}</span> : null}
          <h3 className="min-w-0 flex-1 truncate text-[14px] leading-6 font-medium">
            <Link inherit href={topicHref(topic.id)} className="truncate text-foreground after:absolute after:inset-0">
              {topic.title}
            </Link>
          </h3>
        </div>
        <p className="truncate text-[12px] text-muted-foreground">
          {topic.excerpt}
          <Link inherit href={'#/u/' + topic.author.handle} className="relative z-10 ml-1.5 text-muted-foreground">
            @{topic.author.nickname}
          </Link>
        </p>
      </div>
      <div className="mt-0.5 hidden shrink-0 items-center justify-end gap-2.5 text-[12px] whitespace-nowrap text-muted-foreground md:flex">
        <Reply value={topic.reply_count} className="w-11 justify-end" />
        <Like value={topic.like_count} className="w-10 justify-end" />
        <View value={topic.view_count} className="w-12 justify-end" />
        <time className="text-right" dateTime={topic.last_reply_at}>{formatTime(topic.last_reply_at)}</time>
      </div>
    </li>
  );
}

function TopicCard({ topic }: { topic: Topic }) {
  return (
    // 横向卡片：封面在左固定 160px、内容在右。比竖向卡片矮一半，1440×900 才能完整看到 4 张以上
    <Panel className="relative flex flex-row overflow-hidden p-0">
      {topic.cover === undefined ? (
        <div aria-hidden className="h-28 w-40 shrink-0 self-stretch border-r border-border bg-[repeating-linear-gradient(45deg,var(--muted)_0_8px,transparent_8px_16px)]" />
      ) : (
        <img src={topic.cover} alt="" width={320} height={224} loading="lazy" className="h-28 w-40 shrink-0 self-stretch border-r border-border object-cover" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <KindTag kind={topic.kind} />
          {topic.pinned ? <Tag readOnly tagType={TagType.MAIN}>置顶</Tag> : null}
          {topic.featured === true ? <Tag readOnly tagType={TagType.WARNING}>精华</Tag> : null}
        </div>
        <h3 className="line-clamp-2 text-[15px] leading-6 font-medium">
          <Link inherit href={topicHref(topic.id)} className="text-foreground after:absolute after:inset-0">
            {topic.title}
          </Link>
        </h3>
        <p className="line-clamp-2 text-[12px] text-muted-foreground">{topic.excerpt}</p>
        <div className="mt-auto flex items-center gap-2 pt-0.5 text-[12px] text-muted-foreground">
          <Avatar
            url={topic.author.avatar || null}
            username={topic.author.nickname}
            size={18}
            round
            style={AVATAR_STYLE}
            alt={topic.author.nickname + ' 的头像'}
          />
          <Link inherit href={'#/u/' + topic.author.handle} className="relative z-10 truncate text-muted-foreground">
            {topic.author.nickname}
          </Link>
          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
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

// ——— 三态 ———
function Skeleton({ card }: { card: boolean }) {
  const cells = card ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  return (
    <ul aria-busy="true" aria-live="polite" className={card ? 'flex flex-col gap-2' : 'flex flex-col gap-1'}>
      <li className="col-span-full flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
        <LoaderInline aria-hidden />
        正在加载主题…
      </li>
      {cells.map((k) => (
        <li key={k} className={card ? 'rounded-sm border border-border p-3' : 'flex items-center gap-2.5 px-2 py-2'}>
          <span className={card ? 'block' : 'contents'}>
            <span className={cn('block animate-pulse rounded-sm bg-muted', card ? 'aspect-video w-full' : 'size-7 shrink-0 rounded-full')} />
            <span className={cn('block space-y-1.5', card ? 'mt-2' : 'min-w-0 flex-1')}>
              <span className="block h-4 w-3/5 animate-pulse rounded-sm bg-muted" />
              <span className="block h-3 w-5/6 animate-pulse rounded-sm bg-muted" />
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
      <p className="text-[12px] text-muted-foreground">换个标签看看，或者发第一个主题。</p>
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

export default function BoardPageV1() {
  const [slug, setSlug] = useUrlState('board', 'campaign');
  const [tab, setTab] = useUrlState('tab', 'all');
  const [sort, setSort] = useState('last_reply');
  const [query, setQuery] = useState('');
  const [joined, setJoined] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [demo, setDemo] = useState<(typeof STATES)[number]['key']>('list'); // 预览开关，不是产品功能
  const [mode, setMode] = useViewMode();
  const feed = useFeed();

  const board = BOARDS[slug] ?? BOARDS['campaign'];
  if (board === undefined) throw new Error('假数据缺少 campaign 版块');
  const tabLabel = TABS.find((t) => t.key === tab)?.label ?? '全部';
  const all = filterTopics(board, tab as BoardTab);
  const shown = all.slice(0, feed.items.length).length;
  const loading = demo === 'loading';
  const items = loading || demo === 'error' || demo === 'empty' ? [] : all.slice(0, feed.items.length);
  const pinned = items.filter((t) => t.pinned === true);
  const rest = items.filter((t) => t.pinned !== true);

  return (
    <div className={cn('min-h-screen w-full overflow-x-hidden bg-background text-foreground', TOKENS)}>
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-card px-3 sm:px-4">
        <Link href="#/" className="shrink-0 text-[14px] font-semibold no-underline">
          SC2clud
        </Link>
        <span aria-hidden className="hidden text-border sm:inline">|</span>
        <nav aria-label="站点导航" className="hidden items-center gap-3 text-[13px] sm:flex">
          <Link href="#/boards">版块</Link>
          <Link href="#/latest">最新</Link>
          <Link href="#/launcher">启动器</Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Input size={InputSize.M} placeholder="搜索全站" aria-label="搜索全站" icon={Search} className="hidden md:flex" />
          <Button onClick={() => toggleTheme()}>{currentTheme() === 'dark' ? '浅色' : '深色'}</Button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1440px] grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="hidden lg:block">
          <BoardSidebar active={board.slug} onPick={(s) => setSlug(s)} />
        </div>
        <main className="min-w-0">
          <BoardHeader
            board={board}
            tab={tab as BoardTab}
            onTab={setTab}
            joined={joined}
            onJoinToggle={() => setJoined(!joined)}
            onOpenBoards={() => setDrawer(true)}
            query={query}
            onQuery={setQuery}
            onPosted={() => setJoined(true)}
          />

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
            <span className="text-[13px] font-medium">{tabLabel}主题</span>
            <span className="text-[12px] text-muted-foreground tabular-nums">{all.length}</span>
            {query.trim() === '' ? null : (
              <Tag readOnly tagType={TagType.DEFAULT} onRemove={() => setQuery('')}>
                {'搜索：' + query}
              </Tag>
            )}
            <div className="ml-auto flex items-center gap-2">
              <ButtonGroup>
                {SORTS.map((s) => (
                  <Button key={s.key} active={sort === s.key} aria-pressed={sort === s.key} onClick={() => setSort(s.key)}>
                    {s.label}
                  </Button>
                ))}
              </ButtonGroup>
              <ViewToggle mode={mode} onChange={setMode} />
            </div>
          </div>

          <div className="px-3 pb-10 sm:px-4">
            {demo === 'error' ? (
              <ErrorState onRetry={() => setDemo('list')} />
            ) : demo === 'empty' ? (
              <EmptyState />
            ) : (
              <>
                {loading ? <Skeleton card={mode === 'card'} /> : null}
                {!loading && mode === 'compact' ? (
                  <>
                    {pinned.length > 0 ? (
                      <ul className="mt-1.5 flex flex-col gap-0.5 border-b border-border pb-1.5">
                        {pinned.map((t) => (
                          <TopicRow key={t.id} topic={t} />
                        ))}
                      </ul>
                    ) : null}
                    <ul className="mt-1.5 flex flex-col gap-0.5">
                      {rest.map((t) => (
                        <TopicRow key={t.id} topic={t} />
                      ))}
                    </ul>
                  </>
                ) : null}
                {!loading && mode === 'card' ? (
                  <ul className="mt-2.5 flex flex-col gap-2">
                    {[...pinned, ...rest].map((t) => (
                      <li key={t.id} className="flex">
                        <TopicCard topic={t} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {demo === 'list' ? (
                  <Pager feed={feed} shown={shown} total={all.length} className="mt-2" />
                ) : null}
              </>
            )}
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LayoutList aria-hidden className="size-3.5" />
              预览：{mode === 'compact' ? '紧凑视图' : '卡片视图'} · ?view={mode} 由 URL 记住，1 / 2 键可直接切换
            </p>
          </div>
        </main>
      </div>

      <BoardDrawer open={drawer} active={board.slug} onPick={(s) => { setSlug(s); setDrawer(false); }} onClose={() => setDrawer(false)} />

      <footer className="border-t border-border px-3 py-4 text-[12px] text-muted-foreground sm:px-4">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3">
          <span>SC2clud 社区</span>
          <Link href="#/rules">站规</Link>
          <Link href="#/about">关于</Link>
          <span className="ml-auto flex items-center gap-2">
            <MessageSquare aria-hidden className="size-3.5" />
            <ThumbsUp aria-hidden className="size-3.5" />
            <Eye aria-hidden className="size-3.5" />
            假数据预览，不连网
          </span>
        </div>
      </footer>
    </div>
  );
}
