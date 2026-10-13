import { useMemo, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Tooltip from '@jetbrains/ring-ui-built/components/tooltip/tooltip';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { cn } from '@/lib/utils';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';

// 数据表格控件。
// **待提升为 src/ui**：这是「列定义 + 行数据 + 排序指示 + 行选中 + 空态 + 加载态」的通用表格，
// 现在先放在 15-admin 目录里验证；验证通过后应整体搬到 `web/src/ui/data-table.tsx` 供各管理页复用。
//
// 为什么不用 <table>：门禁（gate:ui / ESLint no-restricted-syntax）禁止业务代码手写 table 标签；
// 而且管理表格要的是「列宽可声明、行可选中、单元格里放控件」，div + CSS grid 比 table 更直接。
// 无障碍：容器 role="table"，行/表头/单元格各自带 role，表头带 aria-sort。
//
// 小屏：外层 overflow-x-auto + 内层 minWidth —— 挤不下时**横向滚动**，不让列互相压扁。

export type SortDir = 'asc' | 'desc';
export type Sort = { key: string; dir: SortDir } | null;

export type Column<T> = {
  key: string;
  title: string;
  /** CSS grid track（如 'minmax(180px,1.6fr)'）；不传按 1fr 均分 */
  track?: string;
  sortable?: boolean;
  /** 排序取值：排序在控件内做（调用方只给数据与当前排序状态） */
  sortValue?: (row: T) => string | number;
  align?: 'start' | 'end';
  render: (row: T) => ReactNode;
};

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 行标签（无障碍用：复选框的无形标签会带它） */
  rowLabel: (row: T) => string;
  selectable?: boolean;
  selected?: readonly string[];
  onSelectedChange?: (keys: string[]) => void;
  /** 返回非 null 表示这行不可选（例如超管不可批量操作），字符串就是「为什么」 */
  selectDisabledReason?: (row: T) => string | null;
  sort?: Sort;
  onSortChange?: (next: Sort) => void;
  activeKey?: string | null;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: string;
  /** 内层最小宽度：挤不下就横向滚动（默认 720） */
  minWidth?: number;
  /** 行高：compact 用于审核/日志这类密集列表 */
  density?: 'normal' | 'compact';
  /** 整行提示（例如「AI 转人工」这一行要一眼看出来）；返回 undefined 表示不加 */
  rowClassName?: (row: T) => string | undefined;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowLabel,
  selectable = false,
  selected = [],
  onSelectedChange,
  selectDisabledReason,
  sort = null,
  onSortChange,
  activeKey = null,
  onRowClick,
  loading = false,
  empty = '没有数据',
  minWidth = 720,
  density = 'normal',
  rowClassName,
}: DataTableProps<T>) {
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (va === vb) return 0;
      return (va > vb ? 1 : -1) * dir;
    });
  }, [rows, sort, columns]);

  const selectableRows = useMemo(
    () => sorted.filter((r) => !(selectDisabledReason?.(r) ?? null)),
    [sorted, selectDisabledReason],
  );
  const allChecked = selectableRows.length > 0 && selectableRows.every((r) => selected.includes(rowKey(r)));
  const someChecked = selectableRows.some((r) => selected.includes(rowKey(r)));

  const tracks = (selectable ? ['36px'] : []).concat(columns.map((c) => c.track ?? 'minmax(0,1fr)')).join(' ');
  const pad = density === 'compact' ? 'px-3 py-1.5' : 'px-3 py-2.5';

  function toggleAll() {
    onSelectedChange?.(allChecked ? [] : selectableRows.map(rowKey));
  }

  function toggleRow(row: T) {
    const key = rowKey(row);
    onSelectedChange?.(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  return (
    <div className='overflow-x-auto rounded-md border border-border bg-card'>
      <div role='table' style={{ minWidth }} className='min-w-full'>
        <div
          role='row'
          className='grid items-center gap-2 border-b border-border bg-muted/60 px-2 py-1'
          style={{ gridTemplateColumns: tracks }}
        >
          {selectable ? (
            <span role='columnheader' className='flex items-center justify-center'>
              <Checkbox
                aria-label='全选本页'
                label={null}
                checked={allChecked}
                indeterminate={!allChecked && someChecked}
                disabled={selectableRows.length === 0}
                onChange={toggleAll}
              />
            </span>
          ) : null}
          {columns.map((c) => {
            const active = sort?.key === c.key;
            const SortIcon = !active ? ChevronsUpDown : sort?.dir === 'asc' ? ArrowUp : ArrowDown;
            return (
              <span
                key={c.key}
                role='columnheader'
                aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={cn('flex min-w-0 items-center gap-1', c.align === 'end' && 'justify-end')}
              >
                {c.sortable && onSortChange ? (
                  /* 排序表头：**轻控件**（无框）+ 靠选中态与箭头表达状态。
                     为什么是 ghost 而不是 transparent：Ring 的 .ring-button-transparent 只把背景设成透明，
                     边框来自 .ring-button-block（--ring-button-default-border-color），所以 transparent **仍然有框**；
                     库里的无框写法是 .ring-button-flat，而 ghost 就是 ghost+flat 的组合（与页面上其它轻控件一致）。 */
                  <Button
                    ghost
                    inline={false}
                    height={ControlsHeight.S}
                    active={active}
                    icon={icon16(SortIcon)}
                    onClick={() => onSortChange(active && sort?.dir === 'desc' ? null : { key: c.key, dir: active && sort?.dir === 'asc' ? 'desc' : 'asc' })}
                  >
                    {c.title}
                  </Button>
                ) : (
                  <span className='px-1 text-[12px] font-medium text-muted-foreground'>{c.title}</span>
                )}
              </span>
            );
          })}
        </div>

        {loading ? (
          <div className='flex items-center gap-2 px-3 py-6 text-[13px] text-muted-foreground'>
            <LoaderInline /> 正在加载…
          </div>
        ) : sorted.length === 0 ? (
          <div className='flex flex-col items-center gap-2 px-3 py-10 text-[13px] text-muted-foreground'>
            <Inbox size={20} aria-hidden />
            {empty}
          </div>
        ) : (
          sorted.map((row) => {
            const key = rowKey(row);
            const disabledReason = selectDisabledReason?.(row) ?? null;
            const active = key === activeKey;
            return (
              <div
                key={key}
                role='row'
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'grid items-center gap-2 border-b border-border px-2 last:border-0',
                  pad,
                  onRowClick && 'cursor-pointer',
                  active ? 'bg-primary/8' : 'hover:bg-muted/50',
                  rowClassName?.(row),
                )}
                style={{ gridTemplateColumns: tracks }}
              >
                {selectable ? (
                  <span
                    role='cell'
                    className='flex items-center justify-center'
                    onClick={(e) => e.stopPropagation()}
                  >
                    {disabledReason ? (
                      <Tooltip title={disabledReason}>
                        <Checkbox aria-label={'选择 ' + rowLabel(row)} label={null} checked={false} indeterminate={false} disabled onChange={() => {}} />
                      </Tooltip>
                    ) : (
                      <Checkbox
                        aria-label={'选择 ' + rowLabel(row)}
                        label={null}
                        checked={selected.includes(key)}
                        indeterminate={false}
                        onChange={() => toggleRow(row)}
                      />
                    )}
                  </span>
                ) : null}
                {columns.map((c) => (
                  <span
                    key={c.key}
                    role='cell'
                    className={cn('flex min-w-0 items-center gap-1.5', c.align === 'end' && 'justify-end')}
                  >
                    {c.render(row)}
                  </span>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** 分页条：DevRoom 里用 AppPager（中文文案），真实实现走游标分页 —— 这里只演示控件与统计。 */
export function TableFooter({ total, page, size, onPage, onSize }: {
  total: number;
  page: number;
  size: number;
  onPage: (p: number) => void;
  onSize: (s: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className='flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground'>
      <span>共 {total} 条 · 第 {page} / {pages} 页（真实接口是游标分页，前端只保留「加载更多」或游标栈）</span>
      <span className='flex items-center gap-1'>
        <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button>
        <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</Button>
        <Button onClick={() => onSize(size === 20 ? 50 : 20)}>每页 {size}</Button>
      </span>
    </div>
  );
}