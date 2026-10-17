import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TopicPage } from './topic';

// 「正文不是评论」（用户定调）：正文是 posts 里 floor=1 的那一行，后端 D71 起不再从
// GET /topics/{id}/posts 返回它，但**部署时序差里老响应还带着**。所以这条钉的不是后端，
// 而是「响应里混进了 floor=1 时，评论区照样一个字都不渲染它」——那道防线在
// routes/_parts/mappers.ts 的 toComments（roots 过滤 floor !== 1），这里钉的是**用户看得见的结果**。
//
// 为什么单独一个文件：routes/topic.test.tsx 已 650+ 行（check-size 在册），
// 而这一条与它那批审核 / 举报用例没有公共夹具。

/** 混进响应的正文本行：这串字只出现在 floor=1 那一行的 content_html 里，
 *  帖子正文（content_html）用的是另一段，所以全文里找不到它就等于「没渲染成评论」。 */
const BODY_ROW_TEXT = '正文那一行：不该在评论区复读';
const REPLY_TEXT = '这是 2 楼的正常回复。';

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
  // 与评论列表同口径：只有 floor > 1 那一条算回复
  reply_count: 1,
  like_count: 1,
  view_count: 6,
  issue_open_count: 0,
  review_state: 'approved',
  can_edit: false,
  can_reply: false,
  featured: false,
  pinned: false,
  locked: false,
  viewer: { liked: false, bookmarked: false },
  sources: [],
};

const AUTHOR = { handle: 'demo-voidray', nickname: '虚空辉光舰', avatar_hash: null, role: null };
/** 混进响应的两条：arrived 的顺序就是「老响应先给正文」那种坏形状 */
const POSTS = [
  {
    id: 'p-body', parent_id: null, floor: 1, author: WIRE.author,
    content_html: '<p>' + BODY_ROW_TEXT + '</p>',
    like_count: 0, my_vote: 0, created_at: '2026-10-08T06:35:53Z',
  },
  {
    id: 'p-reply', parent_id: null, floor: 2, author: AUTHOR,
    content_html: '<p>' + REPLY_TEXT + '</p>',
    like_count: 3, dislike_count: 0, my_vote: 0, created_at: '2026-10-13T12:00:00Z',
  },
];

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

vi.mock('@/lib/api/forum', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/forum')>();
  return {
    ...actual,
    fetchTopic: () => Promise.resolve(WIRE),
    // 老响应：正文那一行（floor=1）还在列表里，后面跟着一条真回复
    fetchPosts: () => Promise.resolve({ items: POSTS, next: null }),
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

afterEach(cleanup);

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

it('响应里混进 floor=1 的正文行：它不进评论区，正常回复照旧渲染', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  // 评论区是懒加载模块（Lexical 不进首屏），晚一拍才出现；首跑冷缓存时这一拍实测超过 1s
  const total = await screen.findByTestId('comment-total', undefined, { timeout: 3000 });

  // ① 正常回复没有被一起挡掉（否则这条用例对「filter 写成恒空」也会绿）
  expect(screen.getByText(REPLY_TEXT)).toBeTruthy();
  // ② 正文行一个字都不进评论区：全页找不到它，评论区那一块也找不到
  expect(screen.queryByText(BODY_ROW_TEXT)).toBeNull();
  expect(total.closest('section')?.textContent).not.toContain(BODY_ROW_TEXT);
  // ③ 表头计数回答的是「回复数」（floor > 1），不是楼层数
  expect(total.textContent).toBe('1');
});
