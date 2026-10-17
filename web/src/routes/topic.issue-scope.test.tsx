import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TopicPage } from './topic';

// **讨论帖不做问题反馈**（用户原话：那是给可下载内容 / 地图的问题单）：话题页整屏共用
// 12-topic/topic-view，反馈区与「问题反馈」页签由 props 驱动 —— 这条盯的是**宿主这一层**
// 真的没把它们传下去，而不是盯组件内部（组件那一半见 12-topic/topic-view.test.tsx）。
//
// 为什么单独一个文件：topic.test.tsx 已经 650+ 行（check-size 在册），这一条与它那批
// 审核 / 举报用例没有公共夹具，塞进去只会让那一份更难读。

const WIRE = {
  id: '01a13540-ff54-7f07-a975-51e08a5f831c',
  kind: 'resource',
  title: '第三章「余烬」平衡性改动说明',
  excerpt: '摘要',
  board: { slug: 'custom-campaign', name: '自制战役' },
  author: { handle: 'Alenger', nickname: '爱兰琪尔', avatar_hash: 'a1b2c3', role: null },
  content_md: '正文',
  content_html: '<p>正文第一段。</p>',
  created_at: '2026-10-08T06:35:53Z',
  updated_at: '2026-10-13T12:25:08Z',
  reply_count: 1,
  like_count: 1,
  view_count: 6,
  // 讨论帖在线上也可能带着这个数（同一张详情 DTO），所以故意给它一个非 0 值：
  // 「没有反馈入口」不能靠「计数恰好是 0」蒙对
  issue_open_count: 7,
  review_state: 'approved',
  can_edit: false,
  can_reply: false,
  featured: false,
  pinned: false,
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
  bio: '战役作者',
  status: 'active',
  level: 27,
  exp: 640,
  exp_max: 1000,
  topic_count: 86,
  like_received: 12480,
  joined_at: '2024-03-01T00:00:00Z',
  title: null,
};
const BOARD = {
  slug: 'custom-campaign',
  name: '自制战役',
  description: '',
  cover: null,
  topic_count: 12,
  post_count: 30,
  today_count: 1,
};

// 详情响应的覆盖（默认 null = 用 WIRE）：两条用例只在 kind 上分岔
const mocks = vi.hoisted(() => ({ topic: { current: null as Record<string, unknown> | null } }));

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
  return { ...actual, fetchUserProfile: () => Promise.resolve(PROFILE) };
});
vi.mock('@/lib/api/follow', () => ({
  fetchBoardFollow: () => Promise.resolve({ target: 'board', slug: BOARD.slug, following: false, follower_count: 0 }),
  followBoard: vi.fn(),
  unfollowBoard: vi.fn(),
  fetchUserFollow: () => Promise.resolve({ target: 'user', handle: 'Alenger', following: false, follower_count: 0 }),
  followUser: vi.fn(),
  unfollowUser: vi.fn(),
}));
vi.mock('@/lib/api/rewards', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/rewards')>();
  return { ...actual, fetchUserChannels: () => Promise.resolve([]) };
});
vi.mock('@/lib/perms', () => ({
  useSession: () => ({ session: { handle: 'Alenger', nickname: '爱兰琪尔', avatar: null, perms: [] }, isLoggedIn: true, isLoading: false }),
  can: () => false,
}));

afterEach(() => {
  cleanup();
  mocks.topic.current = null;
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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

it('讨论帖：没有「问题反馈」页签，也没有正文 / 右栏那两处反馈入口', async () => {
  mocks.topic.current = { kind: 'discussion' };
  renderPage();
  await screen.findByTestId('topic-main');

  // 页签只该剩「帖子内容」一颗（用 testid 精确定位，不查文案）
  expect(screen.queryByTestId('topic-tab-issue')).toBeNull();
  // 两处反馈区整块不在了（给的是非 0 的 issue_open_count，所以这不是「计数为 0 恰好没药丸」）
  expect(screen.queryByTestId('issue-nudge-inline')).toBeNull();
  expect(screen.queryByTestId('issue-nudge-rail')).toBeNull();
});

it('资源帖：同一批入口照旧在（别把功能一起删掉）', async () => {
  mocks.topic.current = { kind: 'resource' };
  renderPage();
  await screen.findByTestId('topic-main');

  expect(screen.getByTestId('topic-tab-issue')).toBeTruthy();
  expect(screen.getByTestId('issue-nudge-inline')).toBeTruthy();
  expect(screen.getByTestId('issue-nudge-rail')).toBeTruthy();
});
