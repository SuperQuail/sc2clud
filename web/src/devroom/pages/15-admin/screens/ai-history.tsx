import { useMemo, useState } from 'react';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { History } from 'lucide-react';
import { DataTable } from '../data-table';
import { Panel, Pill, Toolbar } from '../bits';
import {
  AI_CATEGORY_LABEL, AI_HISTORY, AI_VERDICT_LABEL, REVIEW_SOURCE_LABEL, REVIEW_TRIGGER_LABEL,
  fmtTime, relTime, type AiHistoryRow, type AiVerdict,
} from '../mock';

// 审核历史（d7 §5.2 review_events / §8 管理端）。
// **审核是一串事件，不是当前状态**：AI 先说通过、复审再说违规，两条都要留着 —— 申诉时要看的就是它。
// 所以这一屏不是「帖子列表的另一个视图」，而是「判定流水」：一行 = 一次判定。
export function AiHistory() {
  const [verdict, setVerdict] = useState<AiVerdict | 'all'>('all');
  const [source, setSource] = useState<AiHistoryRow['source'] | 'all'>('all');

  const rows = useMemo(
    () => AI_HISTORY.filter((e) => (verdict === 'all' || e.verdict === verdict) && (source === 'all' || e.source === source)),
    [verdict, source],
  );
  const aiToHuman = AI_HISTORY.filter((e) => e.source === 'ai' && e.verdict === 'review').length;

  const columns = [
    {
      key: 'time', title: '时间', track: 'minmax(88px,0.6fr)', sortable: true, sortValue: (r: AiHistoryRow) => r.created_at,
      render: (r: AiHistoryRow) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='text-[12px] text-foreground tabular-nums'>{fmtTime(r.created_at)}</span>
          <span className='text-[10px] text-muted-foreground'>{relTime(r.created_at)}</span>
        </span>
      ),
    },
    {
      key: 'topic', title: '帖子', track: 'minmax(140px,1.6fr)', sortable: true, sortValue: (r: AiHistoryRow) => r.topic_title,
      render: (r: AiHistoryRow) => <span className='min-w-0 truncate text-[12px] text-foreground' title={r.topic_title}>{r.topic_title}</span>,
    },
    {
      key: 'trigger', title: '触发', track: 'minmax(76px,0.7fr)',
      render: (r: AiHistoryRow) => <Pill tone='outline'>{REVIEW_TRIGGER_LABEL[r.trigger]}</Pill>,
    },
    {
      key: 'verdict', title: '判定', track: 'minmax(120px,1fr)',
      render: (r: AiHistoryRow) => (
        <span className='flex min-w-0 flex-wrap items-center gap-1'>
          <Pill tone={r.source === 'ai' ? 'neutral' : 'outline'}>{REVIEW_SOURCE_LABEL[r.source]}</Pill>
          <Pill tone={r.verdict === 'approve' ? 'ok' : r.verdict === 'reject' ? 'danger' : 'warn'}>
            {AI_VERDICT_LABEL[r.verdict]}
          </Pill>
        </span>
      ),
    },
    {
      key: 'reason', title: '理由（reason）', track: 'minmax(200px,2.4fr)',
      render: (r: AiHistoryRow) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          {/* 截断用 min-w-0 + truncate，hover 看全用原生 title（与审核队列同一套做法） */}
          <span className='min-w-0 truncate text-[12px] text-foreground' title={r.reason}>{r.reason}</span>
          {r.categories.length > 0 ? (
            <span className='flex flex-wrap items-center gap-1'>
              {r.categories.map((c) => <span key={c} className='rounded-sm bg-muted px-1 text-[10px] text-muted-foreground'>{AI_CATEGORY_LABEL[c]}</span>)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'model', title: '模型 / 耗时', track: 'minmax(112px,0.9fr)', align: 'end' as const,
      render: (r: AiHistoryRow) => (
        <span className='flex flex-col items-end leading-tight text-[11px] text-muted-foreground tabular-nums'>
          <span>{r.model || '（人工）'}</span>
          <span>{r.latency_ms > 0 ? r.latency_ms + ' ms' : '—'}</span>
        </span>
      ),
    },
  ];

  return (
    <div data-testid='ai-history'>
    <Panel
      title='审核历史'
      note='GET /api/v1/admin/ai/events：review_events 倒序（只增不改，一行 = 一次判定）。AI 转人工的行高亮，那一类要人接手。'
      actions={<Pill tone={aiToHuman > 0 ? 'danger' : 'neutral'}>{'AI 转人工 ' + aiToHuman}</Pill>}
    >
      <Toolbar className='mb-2'>
        <Select
          type={SelectType.INPUT}
          label='结论'
          data={[
            { key: 'all', label: '全部结论' },
            { key: 'approve', label: '通过' },
            { key: 'reject', label: '违规' },
            { key: 'review', label: '拿不准 · 转人工' },
          ]}
          selected={{ key: verdict, label: verdict === 'all' ? '全部结论' : AI_VERDICT_LABEL[verdict] }}
          onSelect={(item) => { if (item) setVerdict(String(item.key) as AiVerdict | 'all'); }}
        />
        <Select
          type={SelectType.INPUT}
          label='判定来源'
          data={[
            { key: 'all', label: '全部来源' },
            { key: 'ai', label: REVIEW_SOURCE_LABEL.ai },
            { key: 'manual', label: REVIEW_SOURCE_LABEL.manual },
            { key: 'trusted', label: REVIEW_SOURCE_LABEL.trusted },
          ]}
          selected={{ key: source, label: source === 'all' ? '全部来源' : REVIEW_SOURCE_LABEL[source] }}
          onSelect={(item) => { if (item) setSource(String(item.key) as AiHistoryRow['source'] | 'all'); }}
        />
        <span className='flex items-center gap-1 text-[11px] text-muted-foreground'>
          <History size={12} aria-hidden />
          {'命中 ' + rows.length + ' / ' + AI_HISTORY.length + ' 条'}
        </span>
      </Toolbar>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.topic_title}
        sort={{ key: 'time', dir: 'desc' }}
        minWidth={760}
        density='compact'
        rowClassName={(r) => (r.source === 'ai' && r.verdict === 'review' ? 'bg-destructive/10' : undefined)}
        empty='这个筛选下还没有判定事件'
      />
    </Panel>
    </div>
  );
}
