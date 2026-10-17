import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { HomePage } from './home';

// 首页顶部那一块搜索（DevRoom 19-search 的 <SearchPanel>）：这里只换网络边界，
// 断言的是**发出去的请求**（两档的 type、q 真的落到 URL 上）与**四态**在真页面里的形态。
// 契约真源：forum/internal/app/search_endpoint.go（type 只认 topics / users；用户档是 SearchItem）。
afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status?: number; body?: unknown };
function mockApi(byPath: (url: string) => Reply) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const reply = byPath(String(url));
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const BOARDS = { data: [{ slug: 'custom-campaign', name: '自制战役', description: '玩家自制战役', cover: null, topic_count: 3 }] };
const FEED = {
  data: [
    {
      id: 'tp-9',
      board: { slug: 'custom-campaign', name: '自制战役' },
      kind: 'discussion',
      title: '信息流里的帖子',
      excerpt: '摘要',
      author: { handle: 'demo-drone', nickname: '工蜂', avatar_hash: null },
      reply_count: 1,
      like_count: 0,
      view_count: 9,
      featured: false,
      pinned: false,
      created_at: '2026-10-12T01:20:00Z',
      last_reply_at: '2026-10-12T03:00:00Z',
      cover_hash: null,
    },
  ],
  next_cursor: null,
};
const HIT = {
  data: [
    {
      id: 'tp-1',
      board: { slug: 'custom-campaign', name: '自制战役' },
      kind: 'resource',
      title: '第三章「余烬」发布',
      excerpt: '四关战役，全语音。',
      // **后端 DTO 的名字**：author.avatar_hash（不是 avatar）、cover_hash、featured
      author: { handle: 'demo-marine', nickname: '陆战队员', avatar_hash: null },
      reply_count: 12,
      like_count: 3,
      view_count: 240,
      featured: true,
      pinned: false,
      created_at: '2026-10-12T01:20:00Z',
      last_reply_at: '2026-10-12T03:00:00Z',
      cover_hash: null,
    },
  ],
  next_cursor: null,
};
// user.SearchItem 逐字（id / handle / nickname / avatar / level / ambiguous）
const USERS = {
  data: [
    { id: 'u1', handle: 'demo-marine', nickname: '陆战队员', avatar: '', level: 5, ambiguous: true },
    { id: 'u2', handle: 'demo-zealot', nickname: '狂热者', avatar: '/img/abc', level: 8, ambiguous: false },
  ],
};

function renderHome(path: string) {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <HomePage />
      </MemoryRouter>
    </Providers>,
  );
}

it('搜索档发的是 ?q=&type=topics：结果只出现在面板里，信息流让位（同一批结果不出现两次）', async () => {
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    if (url.includes('/search')) return { body: HIT };
    return { body: FEED };
  });
  renderHome('/?q=余烬');

  // 搜索面板是 **lazy**（它静态拖进 Ring 的 Tabs → react-virtualized 链，占首屏 53KB）。
  // jsdom 里动态 import 首次解析会超过 waitFor 默认的 1s —— 给足窗口，断言本身没变。
  await waitFor(() => expect(screen.getByTestId('search-results-topics')).toBeTruthy(), { timeout: 10_000 });
  expect(screen.getByRole('link', { name: '第三章「余烬」发布' })).toBeTruthy();
  // 信息流那条不该同时出现（搜索时信息流整体不渲染）
  expect(screen.queryByText('信息流里的帖子')).toBeNull();
  // 请求参数是契约的一部分：type 默认 topics、q 原样带上
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
  expect(calls.some((u) => u.includes('/search') && u.includes('type=topics') && u.includes('q=%E4%BD%99%E7%83%AC'))).toBe(true);
});

it('用户档发的是 ?type=users，结果行是 SearchItem（昵称 + @handle，重名标出来）', async () => {
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    if (url.includes('/search')) return { body: USERS };
    return { body: FEED };
  });
  renderHome('/?q=demo&type=users');

  await waitFor(() => expect(screen.getByTestId('search-results-users')).toBeTruthy());
  expect(screen.getByText('@demo-marine')).toBeTruthy();
  expect(screen.getByText('@demo-zealot')).toBeTruthy();
  expect(screen.getAllByText('重名')).toHaveLength(1);
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
  expect(calls.some((u) => u.includes('type=users'))).toBe(true);
  // 用户档没有游标：要满一页（后端上限 20）
  expect(calls.some((u) => u.includes('type=users') && u.includes('limit=20'))).toBe(true);
});

it('四态在真页面里真的换：空 q 是 idle、有 q 加载中是 loading、500 是 error 且重试可用', async () => {
  // 第一次搜索失败：先看 error 态
  let fail = true;
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    if (url.includes('/search')) {
      return fail
        ? { status: 500, body: { error: { code: 'common.internal', message: '搜索服务不可用' } } }
        : { body: HIT };
    }
    return { body: FEED };
  });
  const { unmount } = renderHome('/?q=余烬');
  expect(screen.getByTestId('search-loading')).toBeTruthy();
  // 5xx 会按默认策略重试（退避 1s+2s），所以这里等久一点
  await waitFor(() => expect(screen.getByTestId('search-error')).toBeTruthy(), { timeout: 10_000 });
  expect(screen.getByText('搜索服务不可用')).toBeTruthy();

  // 重试：这次后端好了 → ready
  fail = false;
  act(() => screen.getByRole('button', { name: '重试' }).click());
  await waitFor(() => expect(screen.getByTestId('search-results-topics')).toBeTruthy(), { timeout: 10_000 });
  unmount();

  // 没有 q 时是 idle（不是空白）：给「查的是什么」的说明
  renderHome('/');
  await waitFor(() => expect(screen.getByTestId('search-idle')).toBeTruthy());
  expect(screen.getByText(/帖子：标题与正文/)).toBeTruthy();
});

// L2（拍板 §L2）：首页信息流的排序档里「最热」这一档**必须打给后端** `sort=hot`。
// 它 2026-10-13 被撤下来过（那时后端只认 latest / new，点了必 400），2026-10-14 后端补齐后接回来。
// 判据是**请求里的 sort 值**：把 hot 静默映射成 latest 也能让页面看着正常 —— 那正是要防的形态。
it('排序点「最热」发的是 sort=hot（不是静默退回 latest）', async () => {
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    return { body: FEED };
  });
  renderHome('/');
  const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
  await waitFor(() => expect(calls().some((u) => u.includes('/api/v1/topics') && u.includes('sort=latest'))).toBe(true));

  act(() => screen.getByRole('button', { name: '最热' }).click());
  await waitFor(() => expect(calls().some((u) => u.includes('/api/v1/topics') && u.includes('sort=hot'))).toBe(true));
  // 三档都在界面上（撤掉的那一版这里只有两颗）
  expect(screen.getByRole('button', { name: '最新回复' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '最新发布' })).toBeTruthy();
});

it('提交才搜：输入框里打字不发请求，回车把 q 落到 URL', async () => {
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    if (url.includes('/search')) return { body: HIT };
    return { body: FEED };
  });
  renderHome('/');
  await waitFor(() => expect(screen.getByTestId('search-input')).toBeTruthy());

  act(() => fireEvent.change(screen.getByTestId('search-input'), { target: { value: '余烬' } }));
  const callsAfterTyping = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
  expect(callsAfterTyping.some((u) => u.includes('/search'))).toBe(false);

  act(() => fireEvent.submit(screen.getByTestId('search-form')));
  // 搜索面板是 **lazy**（它静态拖进 Ring 的 Tabs → react-virtualized 链，占首屏 53KB）。
  // jsdom 里动态 import 首次解析会超过 waitFor 默认的 1s —— 给足窗口，断言本身没变。
  await waitFor(() => expect(screen.getByTestId('search-results-topics')).toBeTruthy(), { timeout: 10_000 });
});
