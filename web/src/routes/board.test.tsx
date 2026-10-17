import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { BoardPage } from './board';

// 分区页的「关注」那一格（L5，拍板：「实现关注功能,但是暂时不需要做关注后的推送,算备用」）。
//
// 这一条盯两件事：
//   1. 关注数**来自真端点**（GET /boards/{slug}/follow 的 follower_count），不再是写死的 0
//      （那格「成员/关注数」在 2026-10-14 之前是恒 0 —— 后端 BoardDTO 里根本没有这个数）；
//   2. 点「关注分区」发的是 PUT /boards/{slug}/follow、点「已关注」发 DELETE —— 幂等端点，
//      回执就是同一份 State，所以界面按回执就地改。
afterEach(() => {
  vi.unstubAllGlobals();
});

const ME = { handle: 'demo-marine', nickname: '陆战队员', perms: [], is_super: false, email_verified: true };

const BOARD = {
  slug: 'general',
  name: '综合讨论',
  description: '什么都聊',
  cover: null,
  topic_count: 12,
  post_count: 30,
  today_count: 2,
};

/** 网络边界：读请求按路径答，写请求记账。 */
function mockApi(overrides: { follow?: number } = {}) {
  const writes: Array<{ method: string; url: string }> = [];
  let following = false;
  let followers = 7;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      const path = new URL(u, 'http://x').pathname;
      // 关注状态：PUT 关注、DELETE 取关，回执就是界面要的那份 State（幂等：重复点也回同一份）
      if (path.endsWith('/api/v1/boards/general/follow')) {
        if (!init?.method || init.method === 'GET') return json({ target: 'board', slug: 'general', following, follower_count: followers });
        writes.push({ method: init.method, url: u });
        following = init.method === 'PUT';
        followers = (overrides.follow ?? 0) > 0 ? overrides.follow! : following ? 8 : 7;
        return json({ target: 'board', slug: 'general', following, follower_count: followers });
      }
      // 关注者（GET /boards/{slug}/followers）：**必须排在下面那条 /api/v1/boards/ 通配之前**，
      // 否则它会拿到分区详情对象，列表渲染当场 TypeError（这是真的会在浏览器里炸的那一类）。
      if (path.endsWith('/api/v1/boards/general/followers')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'u-9', handle: 'demo-drone', nickname: '工蜂', avatar_hash: '', avatar_small_hash: '', followed_at: '2026-10-11T00:00:00Z' }], next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/api/v1/me')) return json(ME);
      if (u.includes('/api/v1/site')) return json({ name: 'SC2clud', announcements: [], banner: null });
      // 列表（左栏 BoardRail 要数组，它的 data.map 不认单对象） vs 详情
      if (path.endsWith('/api/v1/boards')) return json([BOARD]);
      if (path.includes('/api/v1/boards/')) return json(BOARD);
      // 帖子列表：空列表就够（这一条只验关注那两块）
      return new Response(JSON.stringify({ data: [], next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return writes;
}

function renderBoard() {
  return render(
    <Providers>
      <MemoryRouter initialEntries={['/b/general']}>
        <Routes>
          <Route path='/b/:slug' element={<BoardPage />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

it('分区页的「关注数」来自 GET /boards/{slug}/follow，点关注发 PUT、再点发 DELETE', async () => {
  const writes = mockApi();
  renderBoard();

  // 真数（7），不是写死的 0
  expect(await screen.findByText(/7 关注/)).toBeTruthy();
  const btn = await screen.findByTestId('board-follow');
  expect(btn.textContent).toContain('关注分区');

  fireEvent.click(btn);
  await waitFor(() => expect(writes.some((w) => w.method === 'PUT' && w.url.includes('/api/v1/boards/general/follow'))).toBe(true));
  // 回执直接改界面（幂等端点回的就是这份 State）
  expect(await screen.findByText(/8 关注/)).toBeTruthy();
  expect(screen.getByTestId('board-follow').textContent).toContain('已关注');

  fireEvent.click(screen.getByTestId('board-follow'));
  await waitFor(() => expect(writes.some((w) => w.method === 'DELETE')).toBe(true));
  expect(await screen.findByText(/7 关注/)).toBeTruthy();
  expect(screen.getByTestId('board-follow').textContent).toContain('关注分区');
});

// 关注者（GET /boards/{slug}/followers，follow.UserItem 列表，公开读）：
// 分区页此前只有一个关注**数**，这一格回答「是谁」；每一行链回那个人自己的主页。
it('关注者：GET /boards/{slug}/followers 列出关注这个分区的人', async () => {
  mockApi();
  renderBoard();
  await screen.findByTestId('board-followers');
  const link = await screen.findByRole('link', { name: /工蜂/ });
  expect(link.getAttribute('href')).toBe('/u/demo-drone');
});
