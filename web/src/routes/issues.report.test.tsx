import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { IssuesPage } from './issues';

// 举报入口（issue 也能被举报，契约 target_type='issue'、target_id=issue 的 public_id）：
//   ① issue 列表行与 issue 详情各有一个「举报」；
//   ② 提交打到 POST /reports，body 是 { target_type:'issue', target_id, reason, detail? } —— 字段名逐字对后端。
//
// 与 topic.test.tsx 的举报用例同一套断言形状（那边钉的是 topic/post 两档），
// 这里钉第三档 issue；三条一起才是「值域 topic|post|user|issue」。

const ISSUE_ID = '01a13540-ff54-7f07-a975-51e08a5f831c';
const WIRE = {
  id: ISSUE_ID,
  number: 42,
  kind: 'bug',
  title: '触发器里 Wait 之后变量被清空',
  // 公开 IssueDTO 的 status 值域是 open | closed（keep_open 是**管理端**那一屏的口径，别混用）
  status: 'open',
  author: { handle: 'alice', nickname: '爱丽丝', avatar_hash: null, role: null },
  assignee: null,
  tags: [],
  comment_count: 0,
  created_at: '2026-10-14T10:00:00Z',
  updated_at: '2026-10-15T10:00:00Z',
  closed_at: null,
  topic_id: 't-1',
  topic_title: '教程合集',
  board: { slug: 'tool-dev', name: '工具与开发' },
};

const mocks = {
  fetchIssues: vi.fn(),
  fetchIssue: vi.fn(),
  fetchIssueComments: vi.fn(),
  createReport: vi.fn(),
};

vi.mock('@/lib/api/issues', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/issues')>();
  return {
    ...actual,
    fetchIssues: (...a: unknown[]) => mocks.fetchIssues(...a),
    fetchTopicIssues: (...a: unknown[]) => mocks.fetchIssues(...a),
    fetchIssue: (...a: unknown[]) => mocks.fetchIssue(...a),
    fetchIssueComments: (...a: unknown[]) => mocks.fetchIssueComments(...a),
    fetchIssueCommentReplies: () => Promise.resolve([]),
  };
});
vi.mock('@/lib/api/forum', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/forum')>();
  return { ...actual, createReport: (...a: unknown[]) => mocks.createReport(...a) };
});
vi.mock('@/lib/api/user', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/user')>();
  return { ...actual, searchUsers: () => Promise.resolve([]) };
});
vi.mock('@/lib/perms', () => ({
  useSession: () => ({ session: { handle: 'alice', nickname: '爱丽丝', avatar: null, perms: [] }, isLoggedIn: true, isLoading: false }),
  can: () => false,
}));

afterEach(() => { vi.clearAllMocks(); });

function renderPage() {
  mocks.fetchIssues.mockResolvedValue({ items: [WIRE], next: null });
  mocks.fetchIssue.mockResolvedValue({ ...WIRE, body_html: '<p>正文</p>' });
  mocks.fetchIssueComments.mockResolvedValue({ items: [], next: null });
  mocks.createReport.mockResolvedValue({ id: 'r-1' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/issues']}>
        <IssuesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 列表行上的那颗「举报」（role=button + aria-label，见 13-issue/report-entry.tsx）。 */
const reportBody = () => mocks.createReport.mock.calls[0]?.[0];

it('列表行有举报入口，提交打到 createReport 且 target_type=issue / target_id=public_id', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('issue-report-' + ISSUE_ID));

  fireEvent.click(await screen.findByTestId('report-reason-spam'));
  fireEvent.change(screen.getByTestId('report-detail'), { target: { value: '正文里有外站下载链接' } });
  fireEvent.click(screen.getByTestId('report-submit'));

  await waitFor(() => expect(mocks.createReport).toHaveBeenCalledTimes(1));
  expect(reportBody()).toEqual({
    target_type: 'issue',
    target_id: ISSUE_ID,
    reason: 'spam',
    detail: '正文里有外站下载链接',
  });
  // 回执：不能静默（提交完面板消失、什么话都不说）
  expect(await screen.findByText(/已收到你的举报/)).toBeTruthy();
});

it('issue 详情里也有举报入口，且举报的是详情当前那条', async () => {
  renderPage();
  // 点开列表行 → 详情加载出来
  fireEvent.click(await screen.findByRole('button', { name: /打开反馈 #42/ }));
  await waitFor(() => expect(mocks.fetchIssue).toHaveBeenCalled());

  fireEvent.click(await screen.findByTestId('issue-detail-report'));
  fireEvent.click(await screen.findByTestId('report-reason-abuse'));
  fireEvent.click(screen.getByTestId('report-submit'));

  await waitFor(() => expect(mocks.createReport).toHaveBeenCalledTimes(1));
  expect(reportBody()).toEqual({
    target_type: 'issue',
    target_id: ISSUE_ID,
    reason: 'abuse',
    detail: undefined,
  });
});
