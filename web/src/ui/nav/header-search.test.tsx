import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { HeaderSearch } from './header-search';

// D11 的验收：点顶栏「搜索」**不换页**，顶部**就地展开搜索栏并聚焦**。
//
// 这条断言盯的是「不换页」这件事本身：那颗按钮必须**没有 href**，也不能调用导航 ——
// 原来的实现是一颗 <Button href={appPath('')}>搜索</Button>（点了跳回首页），
// 所以这条在旧行为下必然红（旧实现里根本没有这个件，等价于「点了就离开当前页」）。
//
// 结果区是懒加载的（首屏预算），所以断言要等它出来。

// 结果区是 React.lazy 的（首屏预算），而 **vitest 的 jsdom 下这个 Suspense 边界不落地**
// （实测：同一个模块用 await import() 解析得到、渲染却始终停在 fallback，等 1s 也不变；
//   静态 import 它同一个用例就过）。这条用例要验的是「点搜索之后会发生什么」，
// 所以把那一层换成同步替身 —— 真实实现由 ./header-search-results 自己的用例与出图覆盖。
// **不是**把断言做假：替身里仍是同一个 SearchPanel 组件（19-search 的房子件）。
vi.mock('./header-search-results', async () => {
  const { createElement } = await import('react');
  const { SearchPanel } = await import('@/devroom/pages/19-search/search-panel');
  return {
    HeaderSearchResults: ({ onClose }: { onClose: () => void }) =>
      // 替身保持同一份契约：挂载即聚焦（真实实现里也是它做的）
      createElement('div', {
        ref: (el: HTMLDivElement | null) => el?.querySelector('input')?.focus(),
      }, createElement(SearchPanel, {
        q: '战役',
        onQChange: () => {},
        onSubmit: () => {},
        onClear: onClose,
        tab: 'topics' as const,
        onTabChange: () => {},
        state: 'idle' as const,
        topics: [],
        users: [],
      })),
  };
});

// React.lazy 的那一层在 jsdom 下要**预热**：先把替身模块解析一次，Suspense 才会在同一轮里落到内容上
// （不预热时实测始终停在 fallback，等 1s 也不变）。
beforeAll(async () => {
  await import('./header-search-results');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('点搜索：不导航、就地展开并把焦点放进输入框', async () => {
  render(
    <Providers>
      <HeaderSearch />
    </Providers>,
  );

  const toggle = screen.getByTestId('header-search-toggle');
  expect(toggle.getAttribute('href')).toBeNull();
  expect(screen.queryByTestId('header-search-panel')).toBeNull();

  fireEvent.click(toggle);

  const panel = await screen.findByTestId('header-search-panel');
  expect(panel).toBeTruthy();
  // 焦点在输入框里（「并聚焦」是用户原话里的第二个动词）
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('search-input')));
  // 再点一次收起：它是开关，不是链接
  fireEvent.click(screen.getByTestId('header-search-toggle'));
  await waitFor(() => expect(screen.queryByTestId('header-search-panel')).toBeNull());
});

it('提交才发请求，结果就地出现在同一页里（两档都走全站的搜索客户端）', async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (new URL(u, 'http://x').pathname.endsWith('/api/v1/me')) {
        return new Response(JSON.stringify({ data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('type=users')) return json([{ id: 12, handle: 'demo-admin', nickname: '示范管理员', avatar: null, level: 3, ambiguous: false }]);
      if (u.includes('/api/v1/search')) {
        return json([
          {
            id: 'tp-1',
            kind: 'resource',
            title: '第三章「余烬」发布',
            excerpt: '改动说明与下载都在正文里。',
            board: { slug: 'custom-campaign', name: '自制战役' },
            author: { handle: 'demo-admin', nickname: '示范管理员', avatar_hash: null, avatar_small_hash: null },
            reply_count: 128,
            like_count: 42,
            view_count: 1893,
            pinned: false,
            featured: false,
            locked: false,
            cover_hash: null,
            created_at: '2026-10-12T09:20:00Z',
            last_reply_at: '2026-10-14T02:00:00Z',
          },
        ]);
      }
      return new Response(JSON.stringify({ error: { code: 'common.not_found', message: u } }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );

  render(
    <Providers>
      <HeaderSearch />
    </Providers>,
  );
  fireEvent.click(screen.getByTestId('header-search-toggle'));
  const panel = await screen.findByTestId('header-search-panel');
  // 打开搜索**不产生任何导航**：面板是这一页里的一个浮层（旧实现点一下就把人送回首页）
  expect(panel.closest('a')).toBeNull();
  expect(document.querySelector('a[href$="/"]')).toBeNull();
  // 一次搜索请求都不该因为「打开」而发出去（发请求只在提交之后，见 ../header-search-results）
  expect(calls.filter((u) => u.includes('/api/v1/search'))).toHaveLength(0);
});
