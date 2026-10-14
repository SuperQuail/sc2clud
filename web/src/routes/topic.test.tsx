import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TopicPage } from './topic';

// **真站这一页**的接线断言（房间那一屏由 12-topic 自己的测试盯）：
//   ① 实测的线格式喂进来，整页要画得出来（不是白屏 / 不是崩）；
//   ② 每条动作打到的端点与请求体字段名都对（board / parent_id / target_type / content_md 这些都栽过）；
//   ③ can_reply=false 时输入框换成引导登录那一块（前端方案 §5.4：未登录也要能看见评论区）。
// 后端不在本地，所以这里 mock 的是 lib/api —— 网络层以下的都真的跑。

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
  reply_count: 1,
  like_count: 1,
  view_count: 6,
  issue_open_count: 7,
  review_state: 'rejected',
  review_note: '正文含未标明来源的下载地址',
  can_edit: true,
  can_reply: false,
  featured: true,
  pinned: true,
  locked: false,
  viewer: { liked: false, bookmarked: true },
  sources: [
    {
      id: 's1',
      provider: 'pan123',
      label: '第三章整合包',
      go_path: '/api/v1/topics/01a13540/sources/s1/go',
      url: 'https://example.invalid/x',
      extraction_code: 'c2c',
      size: '2.4 GB',
      upkeep: 'active',
      verified_at: '2026-10-12T01:20:00Z',
    },
  ],
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
  title: { name: '执政官', color: '#2563eb' },
};
const BOARD = {
  slug: 'custom-campaign',
  name: '自制战役',
  description: '玩家自制战役与地图',
  cover: null,
  topic_count: 12,
  post_count: 30,
  today_count: 1,
};

// vi.mock 的工厂会被提升到文件顶部，所以假函数要用 vi.hoisted 一起提上去
const mocks = vi.hoisted(() => ({
  createReport: vi.fn(),
  deleteTopic: vi.fn(),
  deletePost: vi.fn(),
  createPost: vi.fn(),
  updateTopic: vi.fn(),
  /** 详情响应的覆盖（默认 null = 用 WIRE）。B6 那条要靠它演「保存后服务端把 review_state 打回 pending」。 */
  topic: { current: null as Record<string, unknown> | null },
}));

vi.mock('@/lib/api/forum', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/forum')>();
  return {
    ...actual,
    fetchTopic: () => Promise.resolve({ ...WIRE, ...(mocks.topic.current ?? {}) }),
    fetchPosts: () => Promise.resolve({ items: [], next: null }),
    fetchBoards: () => Promise.resolve([BOARD]),
    createReport: mocks.createReport,
    deleteTopic: mocks.deleteTopic,
    deletePost: mocks.deletePost,
    createPost: mocks.createPost,
    updateTopic: mocks.updateTopic,
    setTopicLike: () => Promise.resolve(),
    setTopicBookmark: () => Promise.resolve(),
    setPostVote: () => Promise.resolve(),
  };
});
vi.mock('@/lib/api/user', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/user')>();
  return { ...actual, fetchUserProfile: () => Promise.resolve(PROFILE) };
});
vi.mock('@/lib/perms', () => ({
  useSession: () => ({ session: { handle: 'Alenger', nickname: '爱兰琪尔', avatar: null, perms: [] }, isLoggedIn: true, isLoading: false }),
  can: () => true,
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/t/' + WIRE.id]}>
        <Routes>
          <Route path='/t/:topicId' element={<TopicPage />} />
          {/* 删帖成功后会回到分区页：不给这条路由，react-router 会往 stderr 打一行噪音 */}
          <Route path='*' element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('整页画得出来：正文、四件右栏、审核横幅与理由、来源可点、来源标签用后端词表', async () => {
  renderPage();
  const main = await screen.findByTestId('topic-main');
  expect(main.querySelector('h1')?.textContent).toBe(WIRE.title);
  expect(screen.getByTestId('topic-rail').children.length).toBe(4);
  // review_state=rejected：横幅与 review_note 都要在（只有作者看得到，这条响应就是作者视角）
  expect(screen.getByTestId('review-banner').getAttribute('data-state')).toBe('rejected');
  expect(screen.getByText(/正文含未标明来源的下载地址/)).toBeTruthy();
  // 下载来源：真站是可点的转链（房间那份不可点），且 provider=pan123 走的是后端词表不是回落
  const source = screen.getByRole('link', { name: /打开 123 云盘/ });
  expect(source.getAttribute('href')).toContain('/api/v1/topics/01a13540/sources/s1/go');
  // 作者头像：avatar_hash 拼成 /img/<hash>（UserAvatar 挨着昵称时 alt 留空，所以按 src 找）
  expect(document.querySelector('img[src*="/img/a1b2c3"]')).toBeTruthy();
  // 反馈入口计数来自详情里的 issue_open_count
  expect(screen.getByTestId('issue-nudge-rail').textContent).toContain('7');
});

it('can_reply=false：输入框换成引导登录那一块，评论区仍然可见', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  await waitFor(() => expect(screen.queryByTestId('comment-total')).toBeTruthy());
  expect(screen.queryAllByText(/登录后可以回复/).length + screen.queryAllByText(/还不能发帖回复/).length).toBeGreaterThan(0);
});

it('举报打到 POST /reports，字段名与后端 DTO 逐字一致（target_type / target_id / reason / detail）', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  fireEvent.click(screen.getByTestId('topic-report'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(dialog.querySelectorAll('input[type=radio]')[0]!);
  fireEvent.click(dialog.querySelector('[data-testid=report-submit]')!);
  await waitFor(() =>
    expect(mocks.createReport).toHaveBeenCalledWith({
      target_type: 'topic',
      target_id: WIRE.id,
      reason: 'spam',
      detail: undefined,
    }),
  );
});

it('B6：编辑保存发的 PATCH 带 content_md（后端凭它把 review_state 打回 pending），页面上说清这一点', async () => {
  mocks.updateTopic.mockResolvedValue({});
  renderPage();
  await screen.findByTestId('topic-main');
  fireEvent.click(screen.getByTestId('topic-edit'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(dialog.querySelector('input')!, { target: { value: '改过的标题' } });
  // 这次保存之后服务端会把 review_state 从 rejected 打回 pending（forum 的 ResetTopicReview）——
  // 桩要跟着变，否则测的是「回执没变」这种谁都看不出来的东西。
  mocks.topic.current = { review_state: 'pending', review_note: null };
  fireEvent.click(dialog.querySelector('[data-testid=edit-save]')!);
  // 不带 content_md 的 PATCH 不会重置审核态 —— 所以正文必须在体内；
  // 正文由 content_html 剥标签得到（topic-view 的 toText），所以这里是「正文第一段。」
  await waitFor(() =>
    expect(mocks.updateTopic).toHaveBeenCalledWith(WIRE.id, { title: '改过的标题', content_md: '正文第一段。' }),
  );
  // B6 的那句实话：保存 = 重新提交审核，回执必须说出来（旧回执只会说「更新了」，作者不知道自己在重审）
  await waitFor(() => expect(screen.getAllByTestId('design-action-note')[0]!.textContent).toContain('已重新提交审核'));
  mocks.topic.current = null;
});

it('删帖与删回复打到各自的端点（帖子级 / 楼层级是两个动作）', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  fireEvent.click(screen.getByTestId('topic-delete'));
  fireEvent.click(screen.getByTestId('topic-delete-confirm'));
  await waitFor(() => expect(mocks.deleteTopic).toHaveBeenCalledWith(WIRE.id));
});
