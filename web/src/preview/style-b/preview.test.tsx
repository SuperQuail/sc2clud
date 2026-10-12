import { render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import V1 from './v1';
import V2 from './v2';

// 自检：两个变体都能挂载，列表能从「加载中」走到「有内容」。
// 封面曾经写成 <img src='data:image/svg+xml,…'>：在 <img> 里拿不到 CSS 变量与
// currentColor，整张封面渲染成纯黑。这条断言就是为了不让它回来。
it('v1 渲染顶栏与搜索，列表加载完成后出现内联封面且不含 data: 图片', async () => {
  const { container } = render(<V1 />);
  expect(screen.getAllByText('SC2clud').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('搜索主题')).toBeTruthy();
  expect(screen.getByLabelText('切换深浅色')).toBeTruthy();
  expect(screen.getByRole('status')).toBeTruthy();
  await waitFor(() => expect(container.querySelectorAll('article').length).toBeGreaterThan(0), {
    timeout: 3000,
  });
  expect(container.querySelectorAll('article svg').length).toBeGreaterThan(0);
  expect(container.innerHTML.includes('data:image')).toBe(false);
});

it('v2 渲染左导航与右信息栏，卡片最终落到网格里', async () => {
  const { container } = render(<V2 />);
  expect(screen.getByLabelText('版块导航')).toBeTruthy();
  expect(screen.getByText('今日社区')).toBeTruthy();
  await waitFor(() => expect(container.querySelectorAll('article').length).toBeGreaterThan(0), {
    timeout: 3000,
  });
  expect(container.querySelectorAll('article svg').length).toBeGreaterThan(0);
});
