import type { ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { DataTable } from '../data-table';
import { Panel, Pill } from '../bits';
import { Username } from '@/ui/user/username';
import type { ReviewEventItem } from '@/lib/api/admin';

// D63(b)：审核「历史」档的主体（从 review.tsx 拆出——gate:size 567>500）。
// review_events 倒序的判定流水：一行 = 一次判定。**屏不取数**：props 进来的是
// 容器拉好的一页；filter 与 next_cursor 都在容器手里。与队列同一套视觉语言
//（AI 转人工整行高亮，理由截断 hover 看全 —— 与 demo 的 AiHistory 一致）。

/** D63(b)：历史档主体——review_events 倒序判定流水（本文件的理由见上）。 */
export function EventHistoryPanel({ events, hasMore, loading, error, onLoadEvents }: {
  events: ReviewEventItem[];
  hasMore: boolean;
  loading: boolean;
  error?: ReactNode;
  onLoadEvents?: () => void;
}) {
  const columns = [
    {
      key: 'time', title: '时间', track: 'minmax(96px,0.7fr)', sortable: true,
      sortValue: (r: ReviewEventItem) => r.created_at,
      render: (r: ReviewEventItem) => (
        <span className='text-[12px] text-foreground tabular-nums'>{fmtTime(r.created_at)}</span>
      ),
    },
    {
      key: 'topic', title: '帖子', track: 'minmax(150px,1.7fr)', sortable: true,
      sortValue: (r: ReviewEventItem) => r.topic_title,
      render: (r: ReviewEventItem) => (
        <span className='min-w-0 truncate text-[12px] text-foreground' title={r.topic_title}>{r.topic_title}</span>
      ),
    },
    {
      key: 'trigger', title: '触发', track: 'minmax(72px,0.6fr)',
      render: (r: ReviewEventItem) => <Pill tone='outline'>{EVENT_TRIGGER_LABEL[r.trigger] ?? r.trigger}</Pill>,
    },
    {
      key: 'verdict', title: '判定', track: 'minmax(136px,1.2fr)',
      render: (r: ReviewEventItem) => (
        <span className='flex flex-wrap items-center gap-1'>
          <Pill tone='neutral'>{EVENT_SOURCE_LABEL[r.source] ?? r.source}</Pill>
          <Pill tone={r.verdict === 'approve' ? 'ok' : r.verdict === 'reject' ? 'danger' : 'warn'}>
            {EVENT_VERDICT_LABEL[r.verdict] ?? r.verdict}
          </Pill>
        </span>
      ),
    },
    {
      key: 'reason', title: '理由（reason）', track: 'minmax(170px,2.2fr)',
      render: (r: ReviewEventItem) => (
        <span className='min-w-0 truncate text-[12px] text-foreground' title={r.reason}>
          {r.reason || '（没有留下理由）'}
        </span>
      ),
    },
    {
      key: 'actor', title: '判定人', track: 'minmax(96px,0.9fr)',
      render: (r: ReviewEventItem) => r.actor
        ? <Username nickname={r.actor.nickname} handle={r.actor.handle} size='sm' badge='none' />
        : <span className='text-[11px] text-muted-foreground'>AI / 系统</span>,
    },
    {
      key: 'model', title: '模型 / 耗时', track: 'minmax(104px,0.9fr)', align: 'end' as const,
      render: (r: ReviewEventItem) => (
        <span className='flex flex-col items-end leading-tight text-[11px] text-muted-foreground tabular-nums'>
          <span>{r.model || (r.source === 'manual' ? '（人工）' : '—')}</span>
          <span>{r.latency_ms > 0 ? r.latency_ms + ' ms' : '—'}</span>
        </span>
      ),
    },
  ];
  const toHuman = events.filter((r) => r.source === 'ai' && r.verdict === 'review').length;
  return (
    <Panel
      title='审核历史'
      note='GET /admin/ai/events：review_events 倒序（只增不改，一行 = 一次判定）。'
      actions={<Pill tone={toHuman > 0 ? 'danger' : 'neutral'}>{'AI 转人工 ' + toHuman}</Pill>}
    >
      {error}
      <DataTable
        columns={columns}
        rows={events}
        rowKey={(r) => String(r.id)}
        rowLabel={(r) => r.topic_title}
        minWidth={760}
        density='compact'
        loading={loading}
        rowClassName={(r) => (r.source === 'ai' && r.verdict === 'review' ? 'bg-destructive/10' : undefined)}
        empty='还没有判定事件：AI 或人工判过第一条就会出现'
      />
      {hasMore ? (
        <div className='mt-2'>
          <Button onClick={onLoadEvents} disabled={loading || !onLoadEvents}>加载下一页</Button>
        </div>
      ) : null}
    </Panel>
  );
}

const EVENT_TRIGGER_LABEL: Record<string, string> = { create: '发布', report: '举报复核', manual: '人工' };
const EVENT_SOURCE_LABEL: Record<string, string> = { ai: 'AI', manual: '人工', trusted: '免审' };
const EVENT_VERDICT_LABEL: Record<string, string> = { approve: '通过', reject: '拒绝', review: '转人工' };

/** 时间戳的本地展示（与 review.tsx 同口径；示例数据层不引）。 */
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
