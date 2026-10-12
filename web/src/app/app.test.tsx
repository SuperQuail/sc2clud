import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRouter } from './router';
import { Providers } from './providers';
import { mockFetch } from '@/test/fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
});

// F0 的冒烟测试：整棵 React 树（路由 + Query + api client）能真的起来并拿到数据。
// 只替换网络边界，不 mock 组件本身。
it('首页渲染并显示后端探针返回的版本', async () => {
  mockFetch([{ body: { data: { status: 'ok', version: '0.1.0-dev' } } }]);

  render(
    <Providers>
      <AppRouter />
    </Providers>,
  );

  expect(screen.getByRole('heading', { name: 'SC2clud' })).toBeTruthy();
  await waitFor(() => {
    expect(screen.getByText('ok · v0.1.0-dev')).toBeTruthy();
  });
});
