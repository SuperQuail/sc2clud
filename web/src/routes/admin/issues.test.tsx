import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IssuesAdminScreenContainer } from './issues';
import type { IssueAdmin } from '@/lib/api/admin';

// 「Issue 管理」的容器那一半：屏只把筛选回传，**发什么请求由这里决定**。
// 这一份钉四件事（全都是用户看得见的结果）：
//   ① 归档档位进 query：点「已归档」→ archived=1（服务端筛，前端不本地过滤）；
//   ② 归档要发 POST /admin/issues/{id}/archive 且带 reason；
//   ③ 失败**就地报**（不静默、不假装成功）；
//   ④ 成功后失效这一屏的查询（否则归档完了那一行还在列表里）。

const ISSUE_ID = '01a13540-ff54-7f07-a975-51e08a5f831c';

function row(over: Partial<IssueAdmin> = {}): IssueAdmin {
  return {
    id: ISSUE_ID,
    number: 42,
    kind: 'bug',
    title: '触发器里 Wait 之后变量被清空',
    body_html: '<p>正文</p>',
    status: 'keep_open',
    tags: [],
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-15T10:00:00Z',
    archived_at: null,
    archived_by: null,
    archive_reason: '',
    author: { handle: 'alice', nickname: '爱丽丝', avatar_hash: null },
    topic: { id: 't-1', title: '教程合集' },
    ...over,
  };
}

const ME = {
  id: 'u-1', handle: 'mod', nickname: '审核员', avatar: null,
  email_verified: true, perms: ['post.review'], is_super: false,
  role: { key: 'admin', name: '管理员' }, extra: [],
};

/** 按 URL 分派的桩：超时/session 那条并发查询的顺序不定，按回复顺序发会串（所以不按顺序）。 */
function stub(issues: IssueAdmin[], postStatus = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/me')) return json({ data: ME });
    if (init?.method === 'POST') {
      return json(postStatus === 200 ? { data: { ok: true } } : { error: { code: 'auth.forbidden', message: '没有权限' } }, postStatus);
    }
    return json({ data: issues, next_cursor: null });
  }));
  return calls;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderContainer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><IssuesAdminScreenContainer /></QueryClientProvider>);
  return qc;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('点「已归档」把 archived=1 发给服务端（前端不本地过滤）', async () => {
  const calls = stub([row()]);
  renderContainer();
  await screen.findByTestId('issue-admin-row-' + ISSUE_ID);
  calls.length = 0;

  fireEvent.click(screen.getByRole('button', { name: /已归档/ }));

  await waitFor(() => expect(calls.some((c) => c.url.includes('archived=1'))).toBe(true));
  // 归档档位是**服务端**的筛选：这一页照旧收下后端给的行，屏上不做二次过滤
  expect(calls.some((c) => c.url.includes('/admin/issues'))).toBe(true);
});

it('归档：POST /admin/issues/{id}/archive 且带 reason；成功后失效这一屏的查询', async () => {
  const calls = stub([row()]);
  const qc = renderContainer();
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const target = await screen.findByTestId('issue-admin-row-' + ISSUE_ID);
  calls.length = 0;

  fireEvent.click(within(target).getByRole('button', { name: '归档' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '重复反馈' } });

  fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }));

  await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
  const post = calls.find((c) => c.init?.method === 'POST')!;
  expect(post.url).toContain('/admin/issues/' + ISSUE_ID + '/archive');
  expect(JSON.parse(String(post.init?.body))).toEqual({ reason: '重复反馈' });
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls.some((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey).includes('issues'))).toBe(true);
});

it('归档失败就地报（HTTP 403 的理由要看得见，不假装成功）', async () => {
  const calls = stub([row()], 403);
  renderContainer();
  const target = await screen.findByTestId('issue-admin-row-' + ISSUE_ID);
  calls.length = 0;

  fireEvent.click(within(target).getByRole('button', { name: '归档' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认归档' }));

  const alert = await screen.findByRole('status');
  expect(alert.textContent).toContain('操作失败');
  expect(alert.textContent).toContain('没有权限');
});
