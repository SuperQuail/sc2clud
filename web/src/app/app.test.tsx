import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRouter } from './router';
import { Providers } from './providers';

afterEach(() => {
  vi.unstubAllGlobals();
});

// 整棵 React 树（路由 + Query + api client + 房子件）的冒烟测试：只替换网络边界，不 mock 组件。
// 2026-10-13 改：F0 那版断言的是探针页的 healthz 文案，而首页已经是**真实信息流**，
// 所以这里按 §21.3 的响应形状喂一个帖子，断言它真的渲染成了卡片（含链接与走向）。
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
const TOPICS = {
  data: [
    {
      id: 'tp-1',
      board: { slug: 'custom-campaign', name: '自制战役' },
      kind: 'resource',
      title: '第三章「余烬」发布',
      excerpt: '四关战役，全语音。',
      author: { handle: 'demo-marine', nickname: '陆战队员', avatar: null },
      reply_count: 12,
      like_count: 3,
      view_count: 240,
      featured_at: null,
      pinned: false,
      created_at: '2026-10-12T01:20:00Z',
      last_reply_at: '2026-10-12T03:00:00Z',
      cover: null,
      viewer: { liked: false, bookmarked: false },
    },
  ],
  next_cursor: null,
};

it('首页把 /topics 的响应渲染成卡片，并链到 /t/:id', async () => {
  // 每个页面都会问 /me（登录态的唯一真源）：游客是 200 + data:null
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    return { body: TOPICS };
  });

  render(
    <Providers>
      <AppRouter />
    </Providers>,
  );

  await waitFor(() => {
    expect(screen.getByRole('link', { name: '第三章「余烬」发布' })).toBeTruthy();
  });
  expect(screen.getByRole('link', { name: '第三章「余烬」发布' }).getAttribute('href')).toBe('/t/tp-1');
});

it('首页拿到空列表时给空态（不白屏）', async () => {
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    return { body: { data: [], next_cursor: null } };
  });

  render(
    <Providers>
      <AppRouter />
    </Providers>,
  );

  await waitFor(() => {
    expect(screen.getByText('还没有任何帖子')).toBeTruthy();
  });
});

it('首页接口 500 时给错误态**并带错误编号**（不白屏、不吞错）', async () => {
  mockApi((url) => {
    if (url.includes('/me')) return { body: { data: null } };
    if (url.includes('/boards')) return { body: BOARDS };
    return { status: 500, body: { error: { code: 'common.internal', message: '服务器错误', request_id: 'req-7788' } } };
  });

  render(
    <Providers>
      <AppRouter />
    </Providers>,
  );

  // 5xx 会按 lib/query/client.ts 的默认策略重试 2 次（退避约 1s + 2s），所以要等得久一点
  await waitFor(
    () => {
      expect(screen.getByRole('alert').textContent).toContain('req-7788');
    },
    { timeout: 10_000 },
  );
  expect(screen.getByTestId('retry')).toBeTruthy();
});
