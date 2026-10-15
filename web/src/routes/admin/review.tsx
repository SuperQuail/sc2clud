import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchAiEvents,
  fetchAiPayload,
  fetchReviewQueue,
  reviewTopic,
  testAiConfig,
} from '@/lib/api/admin';
import type {
AiTestView,
ReviewAction,
ReviewQueueItem,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { classifyTestFailure } from './ai';
import { ReviewScreen, type ReviewFilter } from '@/devroom/pages/15-admin/screens/review';
import type { AiTestFailure } from '@/devroom/pages/15-admin/screens/ai-bits';

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
  // D33①③：「这条将要发给 AI 的那一份」与「真跑一次」都**按需**——审核员点了才请求。
  // 不跟着行选择自动拉：队列的用法是扫标题，自动拉就是 N+1 次请求（每点一行一次 dry-run + 一次真外呼的钱）。
  // 存的是**队列项的 id（uuid）**：管理端手上只有它，内部自增 id 不该跨端（见 lib/api/admin.ts）。
  const [payloadId, setPayloadId] = useState<string | null>(null);
  const [topicTest, setTopicTest] = useState<AiTestView | null>(null);
  const [topicTestFailure, setTopicTestFailure] = useState<AiTestFailure | null>(null);

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
    // 「历史」档没有队列语义：不发这一次请求（state=history 对后端是一个无效档位）。
    enabled: filter.state !== 'history',
  });

  // ── 历史（D63(b)）：GET /admin/ai/events，一行 = 一次判定 ──
  // 游标与队列各有一份（同是「不透明串回传」，但换档就作废）：切筛选清两份。
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const events = useQuery({
    queryKey: ['admin', 'review', 'events', eventCursor],
    queryFn: ({ signal }) => fetchAiEvents({ cursor: eventCursor ?? undefined }, signal),
    enabled: filter.state === 'history',
  });

  // 「这条将要发给 AI 的那一份」（dry-run，**不外呼**）：点了才请求（payloadId 为空 = 没点过）。
  const payload = useQuery({
    queryKey: ['admin', 'review', 'payload', payloadId],
    queryFn: ({ signal }) => fetchAiPayload({ topicPublicId: payloadId! }, signal),
    enabled: payloadId !== null,
  });
  // 「真跑一次（含图）」：**真外呼**，但一个字都不落库 —— 这是图片审核起不起效唯一的当场证据（D33③）。
  const testTopic = useMutation({
    mutationFn: (item: ReviewQueueItem) => testAiConfig('', item.id),
    onSuccess: (r) => { setTopicTest(r); setTopicTestFailure(null); },
    // 失败就地显示（D13 的同一套分档）：不 rethrow、不落进路由的错误边界。
    onError: (e) => { setTopicTest(null); setTopicTestFailure(classifyTestFailure(e)); },
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
      onFilterChange={(next) => { setFilter(next); setCursors([null]); setEventCursor(null); }}
      onLoadMore={() => { if (queue.data?.next) setCursors((c) => [...c, queue.data!.next]); }}
      events={filter.state === 'history' ? (events.data?.items ?? null) : null}
      eventsHasMore={Boolean(events.data?.next)}
      eventsLoading={events.isPending}
      eventsError={filter.state === 'history' && events.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          审核历史没能加载（HTTP {isApiError(events.error) ? events.error.status : 0}）：{errorLine(events.error)}
        </p>
      ) : null}
      onLoadEvents={() => { if (events.data?.next) setEventCursor(events.data.next); }}
      canReview={can(me, 'post.review')}
      onReview={(item, action, note) => decide.mutate({ item, action, note })}
      onLoadPayload={(item) => { setPayloadId(item.id); setTopicTest(null); setTopicTestFailure(null); }}
      payload={payloadId === null ? null : (payload.data ?? null)}
      payloadError={payload.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-2 py-1 text-[12px] text-foreground'>
          「将要发给 AI 的那一份」没组装出来（HTTP {isApiError(payload.error) ? payload.error.status : 0}）：{errorLine(payload.error)}
        </p>
      ) : null}
      onTestTopic={(item) => { setTopicTest(null); setTopicTestFailure(null); testTopic.mutate(item); }}
      topicTest={topicTest}
      topicTestFailure={topicTestFailure}
      testing={testTopic.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

