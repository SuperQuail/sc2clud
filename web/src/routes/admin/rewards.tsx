import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchDonationStats,
  fetchDonations,
  fetchNoticeDefaults,
  saveNoticeDefaults,
  verifyDonation,
  verifyDonationsBatch,
} from '@/lib/api/admin';
import type {
BatchItem,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { RewardsScreen, type RewardsFilter } from '@/devroom/pages/15-admin/screens/rewards';

// ── 屏 f：打赏核验队列 ────────────────────────────────────────────────────
// 依赖 GET /admin/rewards、POST /admin/rewards/{id}/verify、POST /admin/rewards/batch、
// GET /admin/rewards/stats、GET/PATCH /admin/donation-notice-defaults —— **五条都已在**。

export function RewardsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<RewardsFilter>({ state: 'pending' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<BatchItem[] | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  const queue = useQuery({
    queryKey: qk.adminRewards({ state: filter.state, cursor }),
    queryFn: ({ signal }) => fetchDonations({ state: filter.state, cursor }, signal),
  });
  const stats = useQuery({ queryKey: qk.adminRewardStats(), queryFn: ({ signal }) => fetchDonationStats(10, signal) });
  const notices = useQuery({ queryKey: qk.adminNoticeDefaults(), queryFn: ({ signal }) => fetchNoticeDefaults(signal) });

  const act = useMutation({
    mutationFn: (v: { ids: string[]; state: 'approved' | 'rejected'; note: string }) =>
      v.ids.length === 1
        ? verifyDonation(v.ids[0]!, v.state, v.note).then(() => ({ results: null as BatchItem[] | null }))
        : verifyDonationsBatch(v.ids, v.state, v.note).then((r) => ({ results: r.results })),
    onSuccess: (r, v) => {
      setBatchResults(r.results);
      setReceipt(r.results === null
        ? '已' + (v.state === 'approved' ? '核验通过' : '拒绝') + ' 1 笔'
        : (r.results.every((x) => x.ok) ? '批量核验 ' + r.results.length + ' 笔，全部成功' : null));
      void qc.invalidateQueries({ queryKey: ['admin', 'rewards'] });
    },
    onError: (e) => { setBatchResults(null); setReceipt('核验失败：' + (errorLine(e) ?? '')); },
  });
  const saveNotices = useMutation({
    mutationFn: saveNoticeDefaults,
    onSuccess: () => { setReceipt('渠道默认文案已整表替换'); void qc.invalidateQueries({ queryKey: qk.adminNoticeDefaults() }); },
    onError: (e) => setReceipt('保存文案失败：' + (errorLine(e) ?? '')),
  });

  const me = session.session;
  return (
    <RewardsScreen
      items={queue.data?.items ?? []}
      hasMore={Boolean(queue.data?.next)}
      loading={queue.isPending}
      error={queue.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          核验队列没能加载（HTTP {isApiError(queue.error) ? queue.error.status : 0}）：{errorLine(queue.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); setBatchResults(null); }}
      onLoadMore={() => { if (queue.data?.next) setCursors((c) => [...c, queue.data!.next]); }}
      stats={stats.data ?? null}
      noticeDefaults={notices.data ?? []}
      onSaveNoticeDefaults={(items) => saveNotices.mutate(items)}
      canVerify={can(me, 'reward.verify')}
      canSiteSetting={can(me, 'site.setting')}
      onVerify={(ids, state, note) => act.mutate({ ids, state, note })}
      batchResults={batchResults}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

