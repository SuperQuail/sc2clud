import { useEffect, useMemo, useRef } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type, type SelectItem } from '@jetbrains/ring-ui-built/components/select/select';
import { Search } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { ISSUE_KIND_META, ISSUE_STATUS_LABEL } from '../12-topic/_task/types';
import { KINDS } from './shared';
import { parseQuery } from './query';
import type { IssueKind, IssueStatus } from './types';

export type SortKey = 'updated' | 'comments' | 'created';
export type Scope = 'all' | 'mine' | 'assigned';

export const SORT_LABEL: Record<SortKey, string> = {
  updated: '最新更新',
  comments: '评论最多',
  created: '最早创建',
};

// Ring UI 的 Select 只认条目对象：selected 要传**条目本身**，不是 key（登记表里记过的坑）
type SortOption = { key: string; label: string };
type StatusOption = { key: string; label: string; value?: IssueStatus };
type KindOption = { key: string; label: string; value?: IssueKind };

const SORT_OPTIONS: Array<SelectItem<SortOption>> = [
  { key: 'updated', label: SORT_LABEL.updated },
  { key: 'comments', label: SORT_LABEL.comments },
  { key: 'created', label: SORT_LABEL.created },
];

const STATUS_OPTIONS: Array<SelectItem<StatusOption>> = [
  { key: 'any', label: '全部状态' },
  ...(['open', 'closed'] as IssueStatus[]).map((s) => ({ key: s, label: ISSUE_STATUS_LABEL[s], value: s })),
];

const KIND_OPTIONS: Array<SelectItem<KindOption>> = [
  { key: 'any', label: '全部类型' },
  ...KINDS.map((k) => ({ key: k, label: ISSUE_KIND_META[k].label, value: k })),
];

const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我创建的' },
  { key: 'assigned', label: '指派给我' },
];

// 检索条：搜索框支持 GitHub 那套限定词（is:/kind:/label:/author:，纯前端解析）。
// **分行的规矩**：带 label 的下拉排一行（它们的高度含 label），范围与标签各占一行。
// 历史缺陷：范围那组 ButtonSet 没有 label、被 items-center 居中，与旁边的下拉差 10px（量过：中心 424 vs 434），
// 看起来就是「按钮错位」。分行之后这类错位从结构上不会再出现。
/** Ctrl/⌘+K 聚焦搜索框：键盘用户不必一路 Tab 过来（GitHub 也是这个键） */
function useSearchShortcut(focus: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);
}

export function IssueFilterBar({
  query,
  onQuery,
  status,
  onStatus,
  kind,
  onKind,
  sort,
  onSort,
  scope,
  onScope,
  labels,
  pickedLabels,
  onToggleLabel,
  onReset,
}: {
  query: string;
  onQuery: (next: string) => void;
  status?: IssueStatus;
  onStatus: (next?: IssueStatus) => void;
  kind?: IssueKind;
  onKind: (next?: IssueKind) => void;
  sort: SortKey;
  onSort: (next: SortKey) => void;
  scope: Scope;
  onScope: (next: Scope) => void;
  labels: string[];
  pickedLabels: string[];
  onToggleLabel: (label: string) => void;
  onReset: () => void;
}) {
  const parsed = useMemo(() => parseQuery(query), [query]);
  const boxRef = useRef<HTMLInputElement | null>(null);
  useSearchShortcut(() => boxRef.current?.focus());
  const statusItem = STATUS_OPTIONS.find((o) => o.value === status) ?? STATUS_OPTIONS[0]!;
  const kindItem = KIND_OPTIONS.find((o) => o.value === kind) ?? KIND_OPTIONS[0]!;
  const sortItem = SORT_OPTIONS.find((o) => o.key === sort) ?? SORT_OPTIONS[0]!;
  const dirty = query !== '' || status !== undefined || kind !== undefined || scope !== 'all' || pickedLabels.length > 0;

  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-3'>
      <Input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder='搜索：标题、正文，或 is:open kind:bug label:界面 author:linshi'
        aria-label='搜索反馈'
        inputRef={boxRef}
        icon={icon16(Search)}
        onClear={() => onQuery('')}
      />
      <p className='text-[11px] leading-relaxed text-muted-foreground'>
        限定词：<code>is:open|closed</code> · <code>kind:bug|feature|difficulty|other</code> · <code>label:标签</code> ·{' '}
        <code>author:handle</code>（可组合，值含空格用引号；认不出的词留在自由文本里搜）
        {parsed.unknown.length > 0 ? (
          <span className='ml-1 text-destructive'>
            没识别：{parsed.unknown.map((t) => t.raw).join('、')}
          </span>
        ) : null}
      </p>

      {/* 带 label 的下拉排一行：它们的高度含 label（48px），必须同排才谈得上对齐。 */}
      <div className='flex flex-wrap items-end gap-x-3 gap-y-2'>
        <span className='w-[150px]'>
          <Select
            type={Type.INPUT}
            data={STATUS_OPTIONS}
            selected={statusItem}
            label='状态'
            onChange={(item: SelectItem<StatusOption> | null) => onStatus(item?.value)}
          />
        </span>
        <span className='w-[160px]'>
          <Select
            type={Type.INPUT}
            data={KIND_OPTIONS}
            selected={kindItem}
            label='类型'
            onChange={(item: SelectItem<KindOption> | null) => onKind(item?.value)}
          />
        </span>
        <span className='w-[150px]'>
          <Select
            type={Type.INPUT}
            data={SORT_OPTIONS}
            selected={sortItem}
            label='排序'
            onChange={(item: SelectItem<SortOption> | null) => onSort((item?.key ?? 'updated') as SortKey)}
          />
        </span>

      </div>

      {/* 范围与标签各占一行：范围原先挤在三个下拉右边、又没有 label，被 items-center 居中后比下拉高 10px，
          看起来就是「按钮错位」。给它自己一行 + 一个 label，从结构上不会再错位，也更好点。 */}
      <div className='flex flex-wrap items-center gap-x-2 gap-y-2'>
        <span className='text-[11px] text-muted-foreground'>范围</span>
        <ButtonSet>
          {SCOPES.map((s) => (
            <Button key={s.key} active={scope === s.key} onClick={() => onScope(s.key)}>
              {s.label}
            </Button>
          ))}
        </ButtonSet>
        {dirty ? (
          <Button ghost onClick={onReset}>
            清空筛选
          </Button>
        ) : null}
      </div>
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='text-[11px] text-muted-foreground'>标签</span>
        <ButtonSet>
          {labels.map((l) => (
            <Button key={l} active={pickedLabels.includes(l)} onClick={() => onToggleLabel(l)}>
              {l}
            </Button>
          ))}
        </ButtonSet>
      </div>
    </section>
  );
}