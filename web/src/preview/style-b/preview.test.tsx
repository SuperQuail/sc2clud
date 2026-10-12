import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import V1 from './v1';
import V2 from './v2';

// 冒烟自检：两个变体都能在 jsdom 里挂载（Ring UI 的枚举与 props 用错会在这里炸）
it('v1 能渲染顶栏与骨架', () => {
  render(<V1 />);
  expect(screen.getAllByText('SC2clud').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('搜索主题')).toBeTruthy();
  expect(screen.getByLabelText('切换深浅色')).toBeTruthy();
});

it('v2 能渲染三栏骨架', () => {
  render(<V2 />);
  expect(screen.getByLabelText('版块导航')).toBeTruthy();
  expect(screen.getByLabelText('搜索主题')).toBeTruthy();
  expect(screen.getByText('今日社区')).toBeTruthy();
});
