import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchReports,
  handleReport,
  handleReportsBatch,
} from '@/lib/api/admin';
import type {
BatchItem,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { ReportsScreen, type ReportFilter } from '@/devroom/pages/15-admin/screens/reports';

// ── 屏 e：举报处理队列 ────────────────────────────────────────────────────
// 依赖 GET /admin/reports、PATCH /admin/reports/{id}、POST /admin/reports/batch（三条都已在）。
// 批量**逐条成败**：后端一个事务 + 逐条 CAS，所以把 results 原样交给屏，不做「全成功」的假设。

export function ReportsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<ReportFilter>({ state: 'open', target_type: 'all' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<BatchItem[] | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  const apiFilter = useMemo(() => ({
    state: filter.state,
    target_type: filter.target_type === 'all' ? undefined : filter.target_type,
    cursor,
  }), [filter, cursor]);

  const queue = useQuery({
    queryKey: qk.adminReports(apiFilter),
    queryFn: ({ signal }) => fetchReports(apiFilter, signal),
  });

  const act = useMutation({
    mutationFn: (v: { ids: string[]; state: 'handled' | 'dismissed'; note: string }) =>
      v.ids.length === 1
        ? handleReport(v.ids[0]!, v.state, v.note).then(() => ({ results: null as BatchItem[] | null }))
        : handleReportsBatch(v.ids, v.state, v.note).then((r) => ({ results: r.results })),
    onSuccess: (r, v) => {
      setBatchResults(r.results);
      setReceipt(r.results === null
        ? '已' + (v.state === 'handled' ? '标记为已处理' : '驳回') + ' 1 条举报'
        : (r.results.every((x) => x.ok) ? '批量处理 ' + r.results.length + ' 条，全部成功' : null));
      void qc.invalidateQueries({ queryKey: ['admin', 'reports'] });
    },
    onError: (e) => { setBatchResults(null); setReceipt('处理失败：' + (errorLine(e) ?? '')); },
  });

  const me = session.session;
  return (
    <ReportsScreen
      items={queue.data?.items ?? []}
      hasMore={Boolean(queue.data?.next)}
      loading={queue.isPending}
      error={queue.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          举报队列没能加载（HTTP {isApiError(queue.error) ? queue.error.status : 0}）：{errorLine(queue.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); setBatchResults(null); }}
      onLoadMore={() => { if (queue.data?.next) setCursors((c) => [...c, queue.data!.next]); }}
      canHandle={can(me, 'report.handle')}
      onHandle={(ids, state, note) => act.mutate({ ids, state, note })}
      batchResults={batchResults}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

