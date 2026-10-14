import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchReviewQueue,
  reviewTopic,
} from '@/lib/api/admin';
import type {
ReviewAction,
ReviewQueueItem,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { ReviewScreen, type ReviewFilter } from '@/devroom/pages/15-admin/screens/review';

// ── 屏 d：帖子审核队列 ────────────────────────────────────────────────────
// 依赖 GET /admin/topics（队列）与 POST /admin/topics/{id}/review（判定）——**两条都已在**。
// 游标分页：cursor 是宿主的本地状态（后端给 next_cursor，前端只回传不解释，拍板 §5.6）。

export function ReviewScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<ReviewFilter>({ state: 'pending', board: 'all', q: '' });
  // 游标栈：改筛选就清空（换了筛选条件，旧游标指向的位置没有意义）
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  // cursor 进 key 也进 query：换一页是另一次查询（key 里不带 cursor 会让每页互相覆盖）
  const apiFilter = useMemo(() => ({
    state: filter.state,
    board: filter.board === 'all' ? undefined : filter.board,
    q: filter.q.trim() || undefined,
    cursor,
  }), [filter, cursor]);

  const queue = useQuery({
    queryKey: qk.adminReview(apiFilter),
    queryFn: ({ signal }) => fetchReviewQueue(apiFilter, signal),
  });

  // 三个动作（拍板 08 · L6 的第四态）：approve 放行 / request_revision 打回修改 / reject 拒绝。
  // 回执用动作名说人话 —— 「打回」与「拒绝」在作者那一侧是两件事，回执也必须分开。
  const ACTION_DONE: Record<ReviewAction, string> = { approve: '通过', reject: '拒绝', request_revision: '打回修改' };
  const decide = useMutation({
    mutationFn: (v: { item: ReviewQueueItem; action: ReviewAction; note: string }) =>
      reviewTopic(v.item.id, v.action, v.note, v.item.updated_at),
    onSuccess: (updated, v) => {
      setReceipt('已' + ACTION_DONE[v.action] + '「' + updated.title + '」');
      void qc.invalidateQueries({ queryKey: ['admin', 'review'] });
    },
    // 版本冲突（作者改了正文 / 别人判过）是**预期内的 400**，不是崩溃：如实说出来让人刷新。
    onError: (e) => setReceipt('判定失败：' + (errorLine(e) ?? '')),
  });

  const me = session.session;
  return (
    <ReviewScreen
      items={queue.data?.items ?? []}
      hasMore={Boolean(queue.data?.next)}
      loading={queue.isPending}
      error={queue.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          队列没能加载（HTTP {isApiError(queue.error) ? queue.error.status : 0}）：{errorLine(queue.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); }}
      onLoadMore={() => { if (queue.data?.next) setCursors((c) => [...c, queue.data!.next]); }}
      canReview={can(me, 'post.review')}
      onReview={(item, action, note) => decide.mutate({ item, action, note })}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

