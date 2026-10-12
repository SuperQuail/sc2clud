import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import V1 from './v1';
import V2 from './v2';

// 冒烟自检：两个变体都要能挂载，且 A（分区头/导航/操作）+ B（两种视图 + 切换进 URL）都在。
afterEach(() => {
  window.history.replaceState(null, '', '/preview.html');
});

it('v1：分区头、统计、标签、两种视图都在，切换写进 URL', () => {
  render(<V1 />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('对战与平衡');
  expect(screen.getByText('今日新帖')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: '分区内导航' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '关注分区' })).toBeTruthy();
  // 分区切换是 Ring UI 的 Dropdown：按钮上写着当前分区名
  expect(screen.getByRole('button', { name: '对战与平衡' })).toBeTruthy();
  // 分区内搜索在窄屏落在分区头里（宽屏那份在顶栏，样式隐藏）
  expect(screen.getAllByRole('search').length).toBe(2);
  for (const form of screen.getAllByRole('search')) {
    expect(within(form).getByLabelText('分区内搜索')).toBeTruthy();
  }

  // 默认卡片视图 → 点「紧凑」后列表换成紧凑行，并把 ?view=compact 写进地址
  expect(screen.getByRole('region', { name: '主题列表（卡片）' })).toBeTruthy();
  act(() => {
    fireEvent.click(screen.getByLabelText('紧凑列表视图'));
  });
  expect(screen.getByRole('region', { name: '主题列表（紧凑）' })).toBeTruthy();
  expect(new URLSearchParams(window.location.search).get('view')).toBe('compact');
});

it('v2：全幅分区头 + 二级分区栏 + 横卡列表都在，默认卡片视图', () => {
  render(<V2 />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('工具与启动器');
  expect(screen.getByRole('navigation', { name: '分区切换' })).toBeTruthy();
  expect(screen.getByRole('navigation', { name: '分区内导航' })).toBeTruthy();
  expect(within(screen.getAllByRole('search')[0]!).getByLabelText('分区内搜索')).toBeTruthy();
  expect(screen.getByRole('region', { name: '主题列表（卡片）' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '关注' })).toBeTruthy();
});
