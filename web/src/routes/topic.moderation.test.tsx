import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { mockFetch } from '@/test/fetch-mock';
import { TopicPage } from './topic';

// **版主的三颗开关**（D73 置顶/精华 + 本次补的锁定）。
// 为什么单拆一个文件：这三颗的形状完全一样（详情里的当前值 + 一个回调，动作条按「回调给了没有」画），
// 而 routes/topic.test.tsx 已在 gate:size 的 PENDING 里挂着（登记的重构目标就是「把宿主各组合拆开」）——
// 再往那边堆就是把那条债加深，所以新的一组建在这里。
//
// 端点（forum/internal/forum/handler.go:89-91）与体字段名逐字对：
//   POST /topics/{id}/pin     权限点 topic.pin    体 {pinned}
//   POST /topics/{id}/feature 权限点 topic.pin    体 {featured}
//   POST /topics/{id}/lock    权限点 **topic.lock** 体 {locked}
// 三条都只回 {ok:true}（不是详情），所以界面靠失效 qk.topic 回读真值。

const WIRE = {
  id: '01a13540-ff54-7f07-a975-51e08a5f831c',
  kind: 'resource',
  title: '第三章「余烬」平衡性改动说明',
  excerpt: '摘要',
  board: { slug: 'custom-campaign', name: '自制战役' },
  author: { handle: 'Alenger', nickname: '爱兰琪尔', avatar_hash: 'a1b2c3', avatar_small_hash: 'd4e5f6' },
  content_md: '正文',
  content_html: '<p>正文第一段。</p>',
  created_at: '2026-10-08T06:35:53Z',
  updated_at: '2026-10-13T12:25:08Z',
  reply_count: 0,
  like_count: 0,
  view_count: 6,
  issue_open_count: 0,
  review_state: 'approved',
  can_edit: false,
  can_reply: false,
  featured: true,
  pinned: true,
  locked: false,
  viewer: { liked: false, bookmarked: false },
  sources: [],
};

const PROFILE = {
  id: 'u1',
  handle: 'Alenger',
  nickname: '爱兰琪尔',
  avatar: '/img/a1b2c3',
  avatar_small: '',
  bio: '',
  status: 'active',
  level: 27,
  exp: 640,
  exp_max: 1000,
  topic_count: 86,
  like_received: 12480,
  joined_at: '2024-03-01T00:00:00Z',
  title: null,
};

const BOARD = { slug: 'custom-campaign', name: '自制战役', description: '', cover: null, topic_count: 12, post_count: 30, today_count: 1 };

const mocks = vi.hoisted(() => ({
  /** 详情响应的覆盖（默认 null = 用 WIRE）；锁定态有「未锁 / 已锁」两档，靠它演 */
  topic: { current: null as Record<string, unknown> | null },
  /** can() 的假实现：默认全有（版主视角），非版主用例临时关掉 */
  canImpl: { current: true },
}));

vi.mock('@/lib/api/forum', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/forum')>();
  return {
    ...actual,
    fetchTopic: () => Promise.resolve({ ...WIRE, ...(mocks.topic.current ?? {}) }),
    fetchPosts: () => Promise.resolve({ items: [], next: null }),
    fetchBoards: () => Promise.resolve([BOARD]),
  };
});
vi.mock('@/lib/api/user', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/user')>();
  return { ...actual, fetchUserProfile: () => Promise.resolve(PROFILE), searchUsers: () => Promise.resolve([]) };
});
vi.mock('@/lib/api/follow', () => ({
  fetchBoardFollow: () => Promise.resolve({ target: 'board', slug: BOARD.slug, following: false, follower_count: 0 }),
  fetchUserFollow: () => Promise.resolve({ target: 'user', handle: 'someone-else', following: false, follower_count: 0 }),
  followBoard: vi.fn(),
  unfollowBoard: vi.fn(),
  followUser: vi.fn(),
  unfollowUser: vi.fn(),
}));
vi.mock('@/lib/perms', () => ({
  useSession: () => ({ session: { handle: 'Alenger', nickname: '爱兰琪尔', avatar: null, perms: [] }, isLoggedIn: true, isLoading: false }),
  can: () => mocks.canImpl.current,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.topic.current = null;
  mocks.canImpl.current = true;
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/t/' + WIRE.id]}>
        <Routes>
          <Route path='/t/:topicId' element={<TopicPage />} />
          <Route path='*' element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('D73：版主看得到置顶/精华两颗开关，点击打到 POST /topics/{id}/pin|feature（体是 {pinned} / {featured}）', async () => {
  const { calls } = mockFetch([{ body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } }]);
  renderPage();
  const pin = await screen.findByTestId('topic-pin-toggle');
  const feat = screen.getByTestId('topic-feature-toggle');
  // 当前值就是详情里的 t.pinned / t.featured（WIRE 两项都是 true）——开关亮着
  expect(pin.className).toContain('ring-button-active');
  expect(feat.className).toContain('ring-button-active');

  // 再点一次是「取消」：上行的是 !current
  fireEvent.click(pin);
  await waitFor(() => expect(calls.some((c) => c.url.includes('/topics/' + WIRE.id + '/pin'))).toBe(true));
  const pinCall = calls.find((c) => c.url.includes('/topics/' + WIRE.id + '/pin'))!;
  expect(pinCall.init?.method).toBe('POST');
  expect(JSON.parse(String(pinCall.init?.body))).toEqual({ pinned: false });

  fireEvent.click(feat);
  await waitFor(() => expect(calls.some((c) => c.url.includes('/topics/' + WIRE.id + '/feature'))).toBe(true));
  const featCall = calls.find((c) => c.url.includes('/topics/' + WIRE.id + '/feature'))!;
  expect(featCall.init?.method).toBe('POST');
  expect(JSON.parse(String(featCall.init?.body))).toEqual({ featured: false });
  cleanup();
});

// 锁定（POST /topics/{id}/lock，权限点 **topic.lock**）：D73 缺的第三颗。
// 判据是「按钮文案跟着 topic.locked 走」+「上行的是 !locked」——两端都钉住，才不是「有个按钮」。
it('锁定：未锁时按钮读「锁定」，点击打到 POST /topics/{id}/lock（体 {locked:true}）', async () => {
  const { calls } = mockFetch([{ body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } }]);
  renderPage();
  const lock = await screen.findByTestId('topic-lock-toggle');
  expect(lock.textContent).toBe('锁定');
  expect(lock.className).not.toContain('ring-button-active');

  fireEvent.click(lock);
  await waitFor(() => expect(calls.some((c) => c.url.includes('/topics/' + WIRE.id + '/lock'))).toBe(true));
  const call = calls.find((c) => c.url.includes('/topics/' + WIRE.id + '/lock'))!;
  expect(call.init?.method).toBe('POST');
  expect(JSON.parse(String(call.init?.body))).toEqual({ locked: true });
  cleanup();
});

it('锁定：已锁时按钮读「解锁」且是选中态，点击上行 {locked:false}', async () => {
  mocks.topic.current = { locked: true };
  const { calls } = mockFetch([{ body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } }]);
  renderPage();
  const lock = await screen.findByTestId('topic-lock-toggle');
  expect(lock.textContent).toBe('解锁');
  expect(lock.className).toContain('ring-button-active');

  fireEvent.click(lock);
  await waitFor(() => expect(calls.some((c) => c.url.includes('/topics/' + WIRE.id + '/lock'))).toBe(true));
  expect(JSON.parse(String(calls.find((c) => c.url.includes('/lock'))!.init?.body))).toEqual({ locked: false });
  cleanup();
});

it('三颗开关没有权限的人一颗都看不到（前端权限只管显不显示，后端仍是唯一拦截点）', async () => {
  mocks.canImpl.current = false;
  renderPage();
  await screen.findByTestId('topic-main');
  expect(screen.queryByTestId('topic-pin-toggle')).toBeNull();
  expect(screen.queryByTestId('topic-feature-toggle')).toBeNull();
  expect(screen.queryByTestId('topic-lock-toggle')).toBeNull();
  cleanup();
});
