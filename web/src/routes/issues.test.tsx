import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { createIssue, fetchIssueCommentReplies, fetchIssues, updateIssue } from '@/lib/api/issues';
import { IssuesPage } from './issues';

// 真页面（routes/issues.tsx）用**设计稿的件**：这里只换网络边界，断言那几件真的渲染出数据，
// 而且用的是**服务端真实的字段**（number / tags / comment_count / body_html / my_vote），不是照 mock 猜的
// （DevRoom 稿里那套 id / labels 是便利命名，照它抄就是 13-issue 事故的重演）。
//
// 为什么这页的测试比别的页重要：路由要 Lead 在 app/router.tsx 里挂一行才可达（W3 不许改那个文件），
// 所以在挂上之前，**这份测试就是「页面真的能渲染出数据」的唯一证据**。
afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status?: number; body?: unknown };

/** 网络边界：记下每次请求的 url / method / body，供「开关真的发了 PATCH」这类断言用。 */
function mockApi(byUrl: (url: string) => Reply | undefined) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const reply = byUrl(u) ?? { status: 404, body: { error: { code: 'common.not_found', message: '没有这个接口：' + u } } };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const ME = { handle: 'demo-marine', nickname: '陆战队员', perms: ['topic.create'], is_super: false, email_verified: true };

// 形状照后端 IssueDTO（forum/internal/forum/dto.go:157-176）：id 是 public_id，number 才是编号，
// 标签叫 tags，作者头像是裸哈希 avatar_hash。
const ISSUE = {
  id: 'i-128',
  number: 128,
  kind: 'bug',
  title: '第三章隐藏结局在 15:00 前抵达也不触发',
  status: 'open',
  author: { handle: 'demo-voidray', nickname: '虚空辉光舰', avatar_hash: null, avatar_small_hash: null },
  assignee: { handle: 'demo-admin', nickname: '示范管理员', avatar_hash: null, avatar_small_hash: null },
  tags: ['战役', '阻塞'],
  comment_count: 1,
  created_at: '2026-10-10T04:00:00Z',
  updated_at: '2026-10-14T02:00:00Z',
  closed_at: null,
  topic_id: 'tp-1',
  topic_title: '第三章「余烬」发布',
  board: { slug: 'custom-campaign', name: '自制战役' },
};

const COMMENT = {
  id: 'c-1',
  parent_id: null,
  body_html: '<p>确认是 bug，下个补丁修。</p>',
  author: { handle: 'demo-admin', nickname: '示范管理员', avatar_hash: null, avatar_small_hash: null },
  like_count: 12,
  dislike_count: 0,
  my_vote: 1,
  created_at: '2026-10-11T04:00:00Z',
  updated_at: '2026-10-11T04:00:00Z',
};

const REPLY = { ...COMMENT, id: 'c-1r1', parent_id: 'c-1', body_html: '<p>旧存档还能救吗？</p>', my_vote: 0 };

function renderIssues(path: string) {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path='/issues' element={<IssuesPage />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

/** 单帖反馈列表 + 详情 + 评论 + 楼中楼的那一套响应（顺序敏感：更长的路径先判）。 */
function issueRoutes(u: string): Reply | undefined {
  if (u.includes('/api/v1/me')) return { body: { data: ME } };
  if (u.includes('/topics/tp-1/issues')) return { body: { data: [ISSUE], next_cursor: null } };
  if (u.includes('/issues/i-128/comments')) return { body: { data: [COMMENT], next_cursor: null } };
  if (u.includes('/issue-comments/c-1/replies')) return { body: { data: [REPLY] } };
  if (u.includes('/issues/i-128')) return { body: { data: { ...ISSUE, body_html: '<p>复现：读档后事件不触发。</p>' } } };
  return undefined;
}

describe('问题反馈页（真端点）', () => {
  it('列表用服务端字段渲染：#编号来自 number、评论数来自 comment_count；点行进详情；开关发 PATCH {status}', async () => {
    const calls = mockApi(issueRoutes);
    renderIssues('/issues?topic=tp-1');

    // number → 卡片上的 #编号；comment_count → 「N 条评论」
    await waitFor(() => expect(screen.getByText('#128')).toBeTruthy());
    expect(screen.getByText('第三章隐藏结局在 15:00 前抵达也不触发')).toBeTruthy();
    expect(screen.getByText('· 1 条评论')).toBeTruthy();
    expect(screen.getByText('虚空辉光舰')).toBeTruthy();
    // 列表请求带的是服务端认的参数（topic 走路径，status 走查询串）
    const listCall = calls.find((c) => c.url.includes('/topics/tp-1/issues'));
    expect(listCall?.url).toContain('status=open');
    expect(listCall?.url).toContain('sort=updated');

    // 点行进详情：正文来自 GET /issues/{id} 的 body_html，评论 + 楼中楼来自评论的两个端点
    fireEvent.click(screen.getByRole('button', { name: /^打开反馈 #128/ }));
    await waitFor(() => expect(screen.getByText('复现：读档后事件不触发。')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('确认是 bug，下个补丁修。')).toBeTruthy());
    expect(screen.getByText('旧存档还能救吗？')).toBeTruthy();
    // 指派给谁也在详情里（字段名 assignee，不是设计稿的 mock 名字）
    expect(screen.getAllByText('示范管理员').length).toBeGreaterThan(0);

    // 开关：Open → Closed 走 PATCH /issues/{id} {status}
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch?.url).toContain('/api/v1/issues/i-128');
      expect(patch?.body).toEqual({ status: 'closed' });
    });
  });

  it('未登录：点「报个 Bug」只给一句实话，不发任何写请求', async () => {
    const calls = mockApi((u) => {
      if (u.includes('/api/v1/me')) return { body: { data: null } };
      if (u.includes('/topics/tp-1/issues')) return { body: { data: [], next_cursor: null } };
      return undefined;
    });
    renderIssues('/issues?topic=tp-1');

    await waitFor(() => expect(screen.getByRole('button', { name: /^报个 Bug/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^报个 Bug/ }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('提反馈要先登录。'));
    // 带 href 的 Ring Button 渲染成 <a>（不是 <button>）
    expect(screen.getByRole('link', { name: '去登录' })).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    // 未登录也不该发「我创建的」那种查询
    expect(calls.every((c) => !c.url.includes('author='))).toBe(true);
  });

  it('列表 500：出的是错误态（带「哪一步没加载」），不是白屏、也不是空列表', async () => {
    mockApi((u) => {
      if (u.includes('/api/v1/me')) return { body: { data: ME } };
      if (u.includes('/topics/tp-1/issues')) return { status: 500, body: { error: { code: 'common.internal', message: '数据库连接失败' } } };
      return undefined;
    });
    renderIssues('/issues?topic=tp-1');

    // 5xx 会被 react-query 重试两次（lib/query/client.ts 的 retry），所以这里的等待窗口要放宽
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('服务器开小差了'), { timeout: 5000 });
    expect(screen.getByRole('alert').textContent).toContain('反馈列表没能加载');
    expect(screen.getByRole('alert').textContent).toContain('数据库连接失败');
    // 错误态长在列表那一格；页面壳照常（不是白屏）：四个入口与检索条都还在
    expect(screen.getByRole('region', { name: '反馈列表' }).textContent).toContain('反馈列表没能加载');
    expect(screen.getByRole('button', { name: /^报个 Bug/ })).toBeTruthy();
    expect(screen.getByLabelText('搜索反馈')).toBeTruthy();
  });
});

// 契约：请求侧字段名照后端 handler.go 的 listIssuesQuery / createIssueBody / updateIssueBody 抄。
// 这一组直接盯着「照设计稿 mock 抄字段名」那类事故（id / labels / body_json 都是错的）。
describe('问题反馈的请求契约', () => {
  it('列表查询串 / 新建请求体 / 开关请求体 / 楼中楼路径逐字对后端', async () => {
    const calls = mockApi((u) => {
      if (u.includes('/issues?') || u.endsWith('/issues') || u.includes('/issues/i-128')) return { body: { data: [], next_cursor: null } };
      if (u.includes('/topics/tp-1/issues')) return { body: { data: {}, next_cursor: null } };
      if (u.includes('/issue-comments/c-1/replies')) return { body: { data: [] } };
      return undefined;
    });

    await fetchIssues({ status: 'open', kind: 'bug', author: 'demo-marine', assignee: 'me', sort: 'comments' });
    expect(calls[0]?.url).toContain('/api/v1/issues?status=open&kind=bug&author=demo-marine&assignee=me&sort=comments');
    expect(calls[0]?.url).toContain('limit=20');

    await createIssue('tp-1', { kind: 'feature', title: '希望支持导出整章', body_md: '正文' });
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toContain('/api/v1/topics/tp-1/issues');
    expect(calls[1]?.body).toEqual({ kind: 'feature', title: '希望支持导出整章', body_md: '正文' });

    await updateIssue('i-128', { status: 'closed' });
    expect(calls[2]?.method).toBe('PATCH');
    expect(calls[2]?.url).toContain('/api/v1/issues/i-128');
    expect(calls[2]?.body).toEqual({ status: 'closed' });

    await fetchIssueCommentReplies('c-1');
    expect(calls[3]?.url).toContain('/api/v1/issue-comments/c-1/replies');
  });
});
