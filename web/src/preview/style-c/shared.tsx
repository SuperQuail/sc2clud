// 方向 C 的共享件：假数据分页器、URL 状态（视图切换要能被 URL 记住）、视图切换控件。
// 这里只有「两个变体都必须一模一样」的东西；版式差异一律留在各自的 v1/v2 里。
// ⚠️ 本目录所有自建控件都待提升为 src/ui（本轮并行做变体，禁止写 web/src/ui）。
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonGroup from '@jetbrains/ring-ui-built/components/button-group/button-group';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { Eye, LayoutGrid, MessageSquare, Rows3, ThumbsUp, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { CURSOR_1, KIND_LABEL, PAGE_1, PAGE_2, type Kind, type Topic, fmt } from './data';

// ——— URL 状态（前端方案 §8：筛选 / 分页 / tab 一律进 URL，不用 useState）———
// 预览没有路由器（router 不归我改），用 History API 直接读写 searchParams：可分享、可后退。
function readParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function useUrlState(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => readParams().get(key) ?? fallback);
  useEffect(() => {
    const sync = (): void => setValue(readParams().get(key) ?? fallback);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [key, fallback]);
  const set = useCallback(
    (v: string) => {
      const p = readParams();
      p.set(key, v);
      window.history.pushState(null, '', '?' + p.toString()); // 进历史：后退键能切回上一个视图
      setValue(v);
    },
    [key],
  );
  return [value, set];
}

// ——— 游标分页（假数据版）：两页就到底，用来验「加载更多 → 没有更多」的文案切换 ———
export type Feed = {
  items: Topic[];
  loading: boolean;
  done: boolean;
  loadMore: () => void;
  reset: () => void;
};

export function useFeed(): Feed {
  const [items, setItems] = useState<Topic[]>(PAGE_1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const id = window.setTimeout(() => {
      setItems((prev) => [...prev, ...PAGE_2]);
      setLoading(false);
      setDone(true);
    }, 600);
    return () => window.clearTimeout(id);
  }, [loading]);
  const loadMore = useCallback(() => {
    if (!loading && !done) setLoading(true);
  }, [loading, done]);
  const reset = useCallback(() => {
    setItems(PAGE_1);
    setLoading(false);
    setDone(false);
  }, []);
  return { items, loading, done, loadMore, reset };
}

export const cursorOf = (done: boolean): string => (done ? '' : CURSOR_1);

// ——— 展示件 ———
export function Stat({ icon: Icon, value, label, className }: { icon: LucideIcon; value: number; label: string; className?: string }) {
  return (
    // 指标名只给读屏：列表里重复 20 遍「回复 12」是噪声（视觉只留图标 + 数字）
    <span className={cn('inline-flex items-center gap-1 tabular-nums', className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span aria-hidden>{fmt(value)}</span>
      <span className="sr-only">{label} {value}</span>
    </span>
  );
}

export const Reply = (p: { value: number; className?: string }) => <Stat icon={MessageSquare} value={p.value} label="回复" className={p.className} />;
export const Like = (p: { value: number; className?: string }) => <Stat icon={ThumbsUp} value={p.value} label="赞" className={p.className} />;
export const View = (p: { value: number; className?: string }) => <Stat icon={Eye} value={p.value} label="浏览" className={p.className} />;

const KIND_TAG: Record<Kind, TagType> = { discussion: TagType.DEFAULT, resource: TagType.MAIN, repost: TagType.PURPLE };

export function KindTag({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <Tag readOnly tagType={KIND_TAG[kind]} className={className}>
      {KIND_LABEL[kind]}
    </Tag>
  );
}

// ——— 视图切换（B3）：状态进 URL，键盘 1 / 2 也能切 ———
export type ViewMode = 'card' | 'compact';

export function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  const [raw, set] = useUrlState('view', 'compact'); // 方向 C 默认落在紧凑视图
  const mode: ViewMode = raw === 'card' ? 'card' : 'compact';
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === '1') set('compact');
      if (e.key === '2') set('card');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);
  return [mode, (v: ViewMode) => set(v)];
}

export function ViewToggle({ mode, onChange, label = false }: { mode: ViewMode; onChange: (v: ViewMode) => void; label?: boolean }) {
  return (
    <ButtonGroup>
      <Button
        icon={Rows3}
        active={mode === 'compact'}
        title="紧凑列表（快捷键 1）"
        aria-pressed={mode === 'compact'}
        onClick={() => onChange('compact')}
      >
        {label ? '紧凑' : null}
      </Button>
      <Button
        icon={LayoutGrid}
        active={mode === 'card'}
        title="卡片（快捷键 2）"
        aria-pressed={mode === 'card'}
        onClick={() => onChange('card')}
      >
        {label ? '卡片' : null}
      </Button>
    </ButtonGroup>
  );
}

// ——— 加载更多（游标分页）：到底换文案，不隐藏按钮（否则会被当成加载失败）———
export function Pager({ feed, shown, total, className }: { feed: Feed; shown: number; total: number; className?: string }) {
  if (feed.loading) {
    return (
      <div className={cn('flex items-center justify-center gap-2 py-4 text-[12px] text-muted-foreground', className)} aria-live="polite">
        <LoaderInline aria-hidden />
        正在加载…
      </div>
    );
  }
  if (feed.done) {
    return (
      <p className={cn('py-4 text-center text-[12px] text-muted-foreground', className)}>
        没有更多了 · 已显示全部 {total} 个主题
      </p>
    );
  }
  return (
    <div className={cn('flex justify-center py-3', className)}>
      <Button onClick={feed.loadMore}>
        加载更多（{shown}/{total}）
      </Button>
    </div>
  );
}
