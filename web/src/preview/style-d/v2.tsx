// 方向 D / v2「全幅封面 + 二级分区栏」：默认卡片视图，一屏 6 张（2 行 × 3 列）。
// 与 v1 的区别全在骨架：分区头是全幅沉浸封面（名称叠在图上），分区切换与分区内标签合并成
// 顶栏下面那条常驻二级栏，卡片是左封面的横卡。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MessageSquare, Moon, PenLine, PlusCircle, Search, Sun } from 'lucide-react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { Art } from './art';
import { Empty, End, Failed, User } from './bits';
import { CardV2, CardV2Skeleton } from './card';
import { RowV2, RowV2Skeleton } from './compact';
import { BoardSwitcher, Stat, TAGS, TagLink, ViewSwitch } from './nav';
import { BOARD_DOT, BOARDS, NOW, readView, useTopicFeed, writeView, type TopicFilter, type ViewMode } from './data';
import { currentTheme, toggleTheme } from '@/lib/theme';

// 默认落在「未关注」的分区：新访客一眼看到的是「关注」而不是「已关注」
const DEFAULT_BOARD = BOARDS[3]!;
const PAGE = 12;
const COVER = 'aspect-[16/10] w-[7.5rem] sm:aspect-[16/9] sm:w-[9.5rem]';

export default function BoardModernV2() {
  const [view, setView] = useState<ViewMode>(() => readView());
  const [board, setBoard] = useState(DEFAULT_BOARD.slug);
  const [tag, setTag] = useState('all');
  const [joined, setJoined] = useState(DEFAULT_BOARD.joined);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [theme, setTheme] = useState(() => currentTheme());
  const sentinel = useRef<HTMLDivElement | null>(null);

  const meta = BOARDS.find((b) => b.slug === board) ?? DEFAULT_BOARD;
  const filter = useMemo<TopicFilter>(() => ({ board, tag, q }), [board, tag, q]);
  const feed = useTopicFeed(filter, PAGE);
  const { state, list, hasMore, loadMore } = feed;

  useEffect(() => {
    writeView(view);
  }, [view]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || state !== 'ready' || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const ob = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    });
    ob.observe(el);
    return () => ob.disconnect();
  }, [state, hasMore, loadMore]);

  const pick = (slug: string) => {
    const next = BOARDS.find((b) => b.slug === slug) ?? DEFAULT_BOARD;
    setBoard(next.slug);
    setJoined(next.joined);
    setTag('all');
  };
  const tags = TAGS;
  const total = tag === 'all' ? meta.topic_count : Math.round(meta.topic_count / 4);

  return (
    <div className='d-v2 min-h-screen bg-background text-foreground'>
      {/* 只在本容器作用域覆盖圆角：v2 更方（4px），与 v1 的 8px 拉开差别 */}
      <style>{'.d-v2{--radius:4px}'}</style>

      <header className='border-b border-border bg-background'>
        <div className='mx-auto flex h-14 w-full max-w-[78rem] items-center gap-3 px-5 sm:gap-5 sm:px-8'>
          <a className='flex shrink-0 items-center gap-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50' href='#/'>
            <span className='rounded-sm bg-primary px-1.5 py-1 font-mono text-[12px] font-semibold text-primary-foreground'>SC2</span>
            <span className='text-[17px] font-semibold tracking-[-0.02em]'>SC2clud</span>
          </a>
          <BoardSwitcher boards={BOARDS} current={board} onPick={pick} />
          <form
            className='ml-auto hidden w-[17rem] shrink-0 lg:block'
            onSubmit={(e) => {
              e.preventDefault();
              setQ(draft.trim());
            }}
            role='search'
          >
            <Input aria-label='分区内搜索' onChange={(e) => setDraft(e.target.value)} placeholder='搜索本分区…' value={draft} />
          </form>
          <Button className='ml-auto shrink-0 lg:ml-0' ghost icon={theme === 'dark' ? Sun : Moon} onClick={() => setTheme(toggleTheme())}>
            {theme === 'dark' ? '浅色' : '深色'}
          </Button>
          <User nickname='唐天' size={32} />
        </div>
      </header>

      {/* A：全幅分区头 —— 封面铺满，名称与统计叠在图上 */}
      <section className='relative isolate overflow-hidden border-b border-border'>
        <Art className='absolute inset-0 text-primary' kind='grid' seed={meta.slug} />
        {/* 遮罩用 background 令牌调出来的渐变：左侧更实（文字区），右侧透出封面 */}
        <span
          aria-hidden
          className='absolute inset-0'
          style={{
            backgroundImage:
              'linear-gradient(96deg, color-mix(in srgb, var(--background) 96%, transparent) 0%, color-mix(in srgb, var(--background) 88%, transparent) 46%, color-mix(in srgb, var(--background) 66%, transparent) 100%)',
          }}
        />
        <div className='relative mx-auto w-full max-w-[78rem] px-5 pt-7 pb-6 sm:px-8 sm:pt-9'>
          <div className='flex flex-wrap items-end justify-between gap-x-8 gap-y-5'>
            <div className='min-w-0 max-w-[48rem]'>
              <p className='flex items-center gap-2 text-[12.5px] text-muted-foreground'>
                <a className='hover:underline' href='#/'>社区</a>
                <span aria-hidden>/</span>
                <a className='hover:underline' href='#/b'>全部分区</a>
                <span aria-hidden>/</span>
                <span className='text-foreground'>{meta.name}</span>
              </p>
              <h1 className='mt-2 text-[32px] leading-tight font-semibold tracking-[-0.025em] sm:text-[40px]'>{meta.name}</h1>
              <p className='mt-2.5 text-[15px] leading-[1.7] text-muted-foreground'>{meta.description}</p>
            </div>

            <div className='flex shrink-0 items-center gap-2'>
              {q === '' ? null : <Button onClick={() => { setQ(''); setDraft(''); }}>清除搜索</Button>}
              <Button icon={PenLine} primary>发帖</Button>
              <Button aria-pressed={joined} icon={joined ? undefined : PlusCircle} onClick={() => setJoined(!joined)}>
                {joined ? '已关注' : '关注'}
              </Button>
            </div>
          </div>

          <dl className='mt-6 grid max-w-[44rem] grid-cols-2 gap-3 sm:grid-cols-4'>
            <Stat boxed name='topic' value={meta.topic_count} />
            <Stat boxed name='post' value={meta.post_count} />
            <Stat boxed name='today' value={meta.today_count} />
            <Stat boxed name='member' value={meta.member_count} />
          </dl>
        </div>
      </section>

      {/* 二级栏：分区切换（横排）+ 分区内标签 + 视图切换 */}
      <div className='sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur'>
        <div className='mx-auto w-full max-w-[78rem] px-5 sm:px-8'>
          <div className='flex items-center gap-3 border-b border-border py-2'>
            <span className='hidden shrink-0 text-[12px] text-muted-foreground sm:inline'>分区</span>
            <nav aria-label='分区切换' className='flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'>
              {BOARDS.map((b) => (
                <a
                  aria-current={b.slug === board ? 'page' : undefined}
                  className={[
                    'flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] whitespace-nowrap outline-none transition-colors',
                    b.slug === board ? 'bg-primary/12 font-semibold text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  ].join(' ')}
                  href={'#/b/' + b.slug}
                  key={b.slug}
                >
                  <span aria-hidden className={['size-1.5 rounded-full', BOARD_DOT[b.slug] ?? 'bg-border'].join(' ')} />
                  {b.name}
                </a>
              ))}
            </nav>
            <ChevronDown aria-hidden className='size-4 shrink-0 text-muted-foreground sm:hidden' />
          </div>

          {/* 分区内搜索：宽屏在顶栏，窄屏在这里 */}
          <form
            className='py-2 lg:hidden'
            onSubmit={(e) => {
              e.preventDefault();
              setQ(draft.trim());
            }}
            role='search'
          >
            <Input
              aria-label='分区内搜索'
              icon={Search}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'在「' + meta.name + '」内搜索…'}
              value={draft}
            />
          </form>

          <div className='flex items-end justify-between gap-4'>
            <nav aria-label='分区内导航' className='-mb-px flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'>
              {tags.map((t) => (
                <TagLink active={t.key === tag} key={t.key} tag={t} />
              ))}
            </nav>
            <div className='flex shrink-0 items-end gap-3 pb-1'>
              <ButtonSet aria-label='排序' className='hidden md:flex'>
                <Button active>最新回复</Button>
                <Button>最新发布</Button>
              </ButtonSet>
              <ViewSwitch dense onChange={setView} view={view} />
            </div>
          </div>
        </div>
      </div>

      <main className='mx-auto w-full max-w-[78rem] px-5 pb-16 sm:px-8'>
        <div className='mt-4 flex flex-wrap items-center gap-3 text-[12.5px] text-muted-foreground'>
          <span>
            共 <span className='text-foreground tabular-nums'>{total}</span> 个主题
            {q === '' ? null : ' · 搜索「' + q + '」'}
          </span>
          <span className='flex items-center gap-2 sm:ml-2'>
            <span className='text-muted-foreground/70'>预览状态</span>
            <Button onClick={feed.retry}>列表</Button>
            <Button onClick={feed.showEmpty}>空</Button>
            <Button onClick={feed.showError}>错误</Button>
          </span>
          <span className='ml-auto hidden items-center gap-1.5 sm:flex'>
            <MessageSquare aria-hidden className='size-3.5' />
            今日新增 {meta.today_count} 帖
          </span>
        </div>

        {view === 'card' ? (
          <section aria-busy={state === 'loading'} aria-label='主题列表（卡片）' className='mt-4 grid grid-cols-1 gap-3.5 lg:grid-cols-2 2xl:grid-cols-3'>
            {state === 'loading' ? (
              <><span className='sr-only'>正在加载主题…</span><CardV2Skeleton coverClass={COVER} /><CardV2Skeleton coverClass={COVER} /><CardV2Skeleton coverClass={COVER} /><CardV2Skeleton coverClass={COVER} /></>
            ) : null}
            {list.map((t) => <CardV2 coverClass={COVER} key={t.id} now={NOW} topic={t} />)}
          </section>
        ) : (
          <section aria-busy={state === 'loading'} aria-label='主题列表（紧凑）' className='mt-2 flex flex-col rounded-md border border-border bg-card px-3 py-2'>
            {state === 'loading' ? <><span className='sr-only'>正在加载主题…</span><RowV2Skeleton /><RowV2Skeleton /><RowV2Skeleton /><RowV2Skeleton /><RowV2Skeleton /></> : null}
            {list.map((t) => <RowV2 key={t.id} now={NOW} topic={t} />)}
          </section>
        )}

        {state === 'empty' ? <div className='mt-6'><Empty hint='换个标签，或者清掉搜索词再看一次；也可以直接开一个新主题。' title='这个筛选下还没有主题' /></div> : null}
        {state === 'error' ? <div className='mt-6'><Failed code='common.internal' onRetry={feed.retry} /></div> : null}

        <div className='h-px' ref={sentinel} />
        {state === 'more' ? <p aria-live='polite' className='py-8 text-center text-[13px] text-muted-foreground'>正在加载更多…</p> : null}
        {state === 'ready' && hasMore ? <div className='flex justify-center pt-6'><Button onClick={loadMore}>加载更多</Button></div> : null}
        {state === 'ready' && !hasMore && list.length > 0 ? <End total={list.length} /> : null}
      </main>
    </div>
  );
}
