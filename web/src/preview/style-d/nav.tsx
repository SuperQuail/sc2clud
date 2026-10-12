// 方向 D / 两个变体共用的页面件：视图切换、统计块、分区下拉、标签导航。
// 控件一律来自 Ring UI（Button / ButtonSet / Input / Select / Avatar）；这里只写组合与布局。
// 本文件里的 BoardSwitcher 与 ViewSwitch 是就地封装（并行做变体，不许写 src/ui），**待提升为 src/ui**。
import { ChevronDown, LayoutGrid, Rows3 } from 'lucide-react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Dropdown from '@jetbrains/ring-ui-built/components/dropdown/dropdown';
import PopupMenu from '@jetbrains/ring-ui-built/components/popup-menu/popup-menu';
import type { Board, ViewMode } from './data';
import { count, TAGS_SOURCE } from './data';

/* ── 视图切换：卡片 ⇄ 紧凑，写进 ?view=card|compact ─────────────────────── */

export function ViewSwitch({
  view,
  onChange,
  className,
  dense = false,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
  className?: string;
  dense?: boolean;
}) {
  return (
    <ButtonSet aria-label='视图切换' className={className}>
      <Button
        aria-label='卡片视图'
        aria-pressed={view === 'card'}
        active={view === 'card'}
        icon={LayoutGrid}
        onClick={() => onChange('card')}
        title='卡片视图'
      >
        {dense ? '' : '卡片'}
      </Button>
      <Button
        aria-label='紧凑列表视图'
        aria-pressed={view === 'compact'}
        active={view === 'compact'}
        icon={Rows3}
        onClick={() => onChange('compact')}
        title='紧凑列表视图'
      >
        {dense ? '' : '紧凑'}
      </Button>
    </ButtonSet>
  );
}

/* ── 分区统计：大数字 + 小标签，两个变体各换一次排布 ────────────────────── */

const STAT_LABEL: Record<string, string> = {
  topic: '主题',
  post: '回复',
  today: '今日新帖',
  member: '成员',
};

export function Stat({
  name,
  value,
  boxed = false,
  className,
}: {
  name: 'topic' | 'post' | 'today' | 'member';
  value: number;
  boxed?: boolean;
  className?: string;
}) {
  const label = STAT_LABEL[name];
  if (boxed) {
    return (
      <div className={['rounded-md border border-border bg-card/80 px-3.5 py-2.5', className ?? ''].join(' ')}>
        <dd className='text-[21px] leading-none font-semibold text-foreground tabular-nums'>{count(value)}</dd>
        <dt className='mt-1.5 text-[11.5px] text-muted-foreground'>{label}</dt>
      </div>
    );
  }
  return (
    <div className={className}>
      <dd className='text-[19px] leading-none font-semibold text-foreground tabular-nums'>{count(value)}</dd>
      <dt className='mt-1 text-[11.5px] text-muted-foreground'>{label}</dt>
    </div>
  );
}


/* ── 分区切换：顶栏下拉（Ring UI Dropdown + PopupMenu，键盘与焦点由它负责） ─ */

export function BoardSwitcher({ boards, current, onPick }: { boards: Board[]; current: string; onPick: (slug: string) => void }) {
  const meta = boards.find((b) => b.slug === current) ?? boards[0];
  return (
    <Dropdown
      anchor={
        <Button className='shrink-0' iconRight={ChevronDown} title='切换分区'>
          {meta ? meta.name : '选择分区'}
        </Button>
      }
    >
      <PopupMenu
        ariaLabel='选择分区'
        closeOnSelect
        data={boards.map((b) => ({ key: b.slug, label: b.name + ' · ' + count(b.topic_count) + ' 主题' }))}
        onSelect={(item) => onPick(String((item as { key: string }).key))}
      />
    </Dropdown>
  );
}

/* ── 分区内标签：横排，当前选中用底部粗条 + 主色 ────────────────────────── */

export const TAGS: { key: string; label: string }[] = TAGS_SOURCE;


export function TagLink({ tag, active }: { tag: { key: string; label: string }; active: boolean }) {
  return (
    <a
      aria-current={active ? 'page' : undefined}
      className={[
        'shrink-0 border-b-2 px-3 pt-2 pb-1.5 text-[14px] whitespace-nowrap outline-none transition-colors',
        active
          ? 'border-primary font-semibold text-foreground'
          : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
      ].join(' ')}
      href={'#/b/' + tag.key}
    >
      {tag.label}
    </a>
  );
}
