import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewScreenContainer } from './review';
import { qk } from '@/lib/query/keys';
import type { ReviewQueueItem } from '@/lib/api/admin';

// 「已经手动通过的帖子编辑，帖子页面不更新」的前端那一半。
//
// 后端那半条路是对的（forum 的 TestModeratorApprovalPromotesEditToTopicDetail 钉住了：
// 放行之后 posts/content_html/摘要/快照一起换新、待审槽清空）。剩下的是**新鲜度**：
// 帖子页的详情查询 staleTime=60s，审核员（或同一浏览器里的任何人）点完「通过」
// 再打开 / 返回帖子页，60 秒内拿到的还是旧缓存 —— 看起来就是「页面不更新」。
//
// 所以审核动作成功后必须把**被审那条主题**的详情/回复与列表一起失效。
// 这条用例钉的就是失效集合本身（不是按钮在不在）。

const TOPIC_ID = '11111111-1111-1111-1111-111111111111';

function queueItem(over: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: TOPIC_ID,
    board: { slug: 'campaign', name: '战役讨论' },
    author: { handle: 'alice', nickname: '爱丽丝', avatar: '', avatar_small: '' },
    kind: 'discussion',
    title: '教程',
    excerpt: '摘要',
    body_md: '正文',
    body_truncated: false,
    review_state: 'approved',
    review_note: null,
    review_source: 'manual',
    reviewer: null,
    reviewed_at: null,
    review_verdict: null,
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-14T10:00:00Z',
    ...over,
  };
}

const ME = {
  id: 'u-1', handle: 'mod', nickname: '审核员', avatar: null,
  email_verified: true, perms: ['post.review'], is_super: false,
  role: { key: 'admin', name: '管理员' }, extra: [],
};

function stubFetch(item: ReviewQueueItem) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = u.includes('/admin/topics/') && init?.method === 'POST'
      ? { data: { ...item, review_state: 'approved' } }
      : u.includes('/admin/topics') ? { data: [item], next_cursor: null }
      : { data: ME };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function renderContainer(item: ReviewQueueItem) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  vi.stubGlobal('fetch', stubFetch(item));
  render(<QueryClientProvider client={qc}><ReviewScreenContainer /></QueryClientProvider>);
  return spy;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('放行之后：被审主题的详情 / 回复与列表一起失效（不只是队列自己）', async () => {
  const spy = renderContainer(queueItem());

  // 队列行挂上来，行内「放行改动」（review_state=approved = 已发布 + 有待替换的改动）
  const go = await screen.findByRole('button', { name: '放行改动' });
  fireEvent.click(go);
  // 二次确认弹层
  fireEvent.click(screen.getByText('通过并发布').closest('button') as HTMLButtonElement);

  await waitFor(() => expect(spy).toHaveBeenCalled());
  const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));

  // 审核动作自己的那一份（原有行为，不许因为这次改动丢掉）
  expect(keys).toContain(JSON.stringify(['admin', 'review']));
  // 被审那条主题：详情与回复 —— 缺了它，帖子页 60 秒内还是旧正文
  expect(keys).toContain(JSON.stringify(qk.topic(TOPIC_ID)));
  expect(keys).toContain(JSON.stringify(qk.posts(TOPIC_ID)));
  // 列表卡片（摘要 / 状态也变了）
  expect(keys).toContain(JSON.stringify(['topics']));
});
