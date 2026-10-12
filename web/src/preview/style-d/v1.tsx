// 方向 D / v1「封面大卡 + 三列卡片」：默认卡片视图，一屏 6 张（2 行 × 3 列）。
// 分区切换走顶栏下拉；分区头是一张封面主导的大卡（左封面 + 右身份与统计）；
// 分区内导航是顶部标签行；紧凑视图（Discord 式）作为可选，切换写进 ?view=。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MessageSquare, Moon, PenLine, Search, PlusCircle, Sun } from 'lucide-react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import type { FormEvent } from 'react';
import { BoardCover } from './art';
import { Empty, End, Failed, User } from './bits';
import { CardV1, CardV1Skeleton } from './card';
import { RowV1, RowV1Skeleton } from './compact';
import { BoardSwitcher, Stat, TAGS, TagLink, ViewSwitch } from './nav';
import { BOARDS, NOW, readView, useTopicFeed, writeView, type TopicFilter, type ViewMode } from './data';
import { currentTheme, toggleTheme } from '@/lib/theme';

// 默认落在「未关注」的分区：新访客一眼看到的是「关注分区」而不是「已关注」
const DEFAULT_BOARD = BOARDS[1]!;
const PAGE = 9;

export default function BoardModernV1() {
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

  // 触底自动翻页；底部同时留「加载更多」按钮（键盘与无 IntersectionObserver 的环境都能用）
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
    <div className='d-v1 min-h-screen bg-background text-foreground'>
      {/* 令牌只在本容器作用域内覆盖：圆角加大到 8px，不改全局（前端方案 §7.1） */}
      <style>{'.d-v1{--radius:8px}'}</style>

      <header className='sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur'>
        <div className='mx-auto flex h-[3.75rem] w-full max-w-[75rem] items-center gap-3 px-5 sm:gap-5 sm:px-8'>
          <a className='flex shrink-0 items-baseline gap-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50' href='#/'>
            <span className='text-[19px] font-semibold tracking-[-0.02em]'>SC2clud</span>
            <span className='hidden text-[13px] text-muted-foreground sm:inline'>社区</span>
          </a>

          <span className='hidden items-center gap-2 md:flex'>
            <span className='text-[13px] text-muted-foreground'>分区</span>
            <BoardSwitcher boards={BOARDS} current={board} onPick={pick} />
          </span>

          <form
            className='ml-auto hidden max-w-[18rem] flex-1 lg:block'
            onSubmit={(e) => {
              e.preventDefault();
              setQ(draft.trim());
            }}
            role='search'
          >
            <Input
              aria-label='分区内搜索'
              onChange={(e) => setDraft(e.target.value)}
              placeholder='搜索本分区…'
              value={draft}
            />
          </form>

          <Button className='ml-auto shrink-0 lg:ml-0' icon={PenLine} onClick={() => undefined} primary>
            发帖
          </Button>
          <Button
            aria-label='切换深浅色'
            className='shrink-0'
            ghost
            icon={theme === 'dark' ? Sun : Moon}
            onClick={() => setTheme(toggleTheme())}
          />
          <User nickname='唐天' size={32} />
        </div>
      </header>

      <main className='mx-auto w-full max-w-[75rem] px-5 pb-16 sm:px-8'>
        {/* A：分区头大卡 —— 封面主导 + 身份 + 统计 + 分区级操作 */}
        <section className='mt-6 overflow-hidden rounded-lg border border-border bg-card'>
          <div className='flex flex-col lg:flex-row'>
            <BoardCover className='aspect-[16/7] w-full shrink-0 lg:aspect-auto lg:w-[21rem]' name={meta.name} slug={meta.slug} />

            <div className='flex min-w-0 flex-1 flex-col gap-3 p-5 sm:p-6'>
              <div className='flex flex-wrap items-center gap-2.5'>
                <h1 className='text-[26px] leading-tight font-semibold tracking-[-0.02em] sm:text-[30px]'>{meta.name}</h1>
                <Button
                  aria-pressed={joined}
                  className='ml-auto shrink-0'
                  icon={joined ? undefined : PlusCircle}
                  onClick={() => setJoined(!joined)}
                  primary={!joined}
                >
                  {joined ? '已关注 · 取消' : '关注分区'}
                </Button>
              </div>

              <p className='max-w-[46rem] text-[14.5px] leading-[1.7] text-muted-foreground'>{meta.description}</p>

              {/* 分区内搜索：宽屏在顶栏，窄屏挪到分区头里 */}
              <form
                className='max-w-[24rem] lg:hidden'
                onSubmit={(e: FormEvent) => {
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

              <dl className='mt-auto flex flex-wrap items-end gap-x-8 gap-y-3 pt-3'>
                <Stat name='topic' value={meta.topic_count} />
                <Stat name='post' value={meta.post_count} />
                <Stat name='today' value={meta.today_count} />
                <Stat name='member' value={meta.member_count} />
                <span className='ml-auto flex items-center gap-1.5 self-center text-[12.5px] text-muted-foreground'>
                  <MessageSquare aria-hidden className='size-4' />
                  今日新增 {meta.today_count} 帖
                </span>
              </dl>
            </div>
          </div>
        </section>

        {/* 分区内搜索（窄屏）/ 标签 / 视图切换 */}
        <div className='mt-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between'>
          <nav aria-label='分区内导航' className='-mb-px flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'>
            {tags.map((t) => (
              <TagLink active={t.key === tag} key={t.key} tag={t} />
            ))}
          </nav>
          <div className='flex shrink-0 items-end gap-3'>
            <ButtonSet aria-label='排序' className='hidden sm:flex'>
              <Button active>最新回复</Button>
              <Button>最新发布</Button>
              <Button>最多回复</Button>
            </ButtonSet>
            <ViewSwitch onChange={setView} view={view} />
          </div>
        </div>

        <div className='mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-[12.5px] text-muted-foreground'>
          <span>
            共 <span className='text-foreground tabular-nums'>{total}</span> 个主题
            {tag === 'all' ? null : ' · 已筛选「' + (tags.find((t) => t.key === tag)?.label ?? tag) + '」'}
            {q === '' ? null : ' · 搜索「' + q + '」'}
          </span>
          {/* 预览状态开关：真项目里这行是排序 / 时间范围，不是演示按钮 */}
          <span className='flex items-center gap-2 sm:ml-2'>
            <span className='text-muted-foreground/70'>预览状态</span>
            <Button onClick={feed.retry}>列表</Button>
            <Button onClick={feed.showEmpty}>空</Button>
            <Button onClick={feed.showError}>错误</Button>
          </span>
          {meta.cover ? <span className='ml-auto hidden items-center gap-1 text-muted-foreground/70 sm:flex'><ChevronDown aria-hidden className='size-3.5' />下拉换分区</span> : null}
        </div>

        {view === 'card' ? (
          <section aria-busy={state === 'loading'} aria-label='主题列表（卡片）' className='mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'>
            {state === 'loading' ? <><span className='sr-only'>正在加载主题…</span><CardV1Skeleton /><CardV1Skeleton /><CardV1Skeleton /></> : null}
            {list.map((t) => <CardV1 key={t.id} now={NOW} topic={t} />)}
          </section>
        ) : (
          <section aria-busy={state === 'loading'} aria-label='主题列表（紧凑）' className='mt-2 flex flex-col gap-0.5'>
            {state === 'loading' ? <><span className='sr-only'>正在加载主题…</span><RowV1Skeleton /><RowV1Skeleton /><RowV1Skeleton /><RowV1Skeleton /></> : null}
            {list.map((t) => <RowV1 key={t.id} now={NOW} topic={t} />)}
          </section>
        )}

        {state === 'empty' ? <div className='mt-6'><Empty hint='换个标签，或者清掉搜索词再看一次；也可以直接开一个新主题。' title='这个筛选下还没有主题' /></div> : null}
        {state === 'error' ? <div className='mt-6'><Failed code='common.internal' onRetry={feed.retry} /></div> : null}

        <div className='h-px' ref={sentinel} />
        {state === 'more' ? <p aria-live='polite' className='py-6 text-center text-[13px] text-muted-foreground'>正在加载更多…</p> : null}
        {state === 'ready' && hasMore ? (
          <div className='flex justify-center pt-6'>
            <Button onClick={loadMore}>加载更多</Button>
          </div>
        ) : null}
        {state === 'ready' && !hasMore && list.length > 0 ? <End total={list.length} /> : null}
      </main>
    </div>
  );
}
