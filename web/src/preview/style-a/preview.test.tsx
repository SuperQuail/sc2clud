// 方向 A 的两个变体共用一条自检：能挂载、四种列表态可切换、游标分页能走到「到底」。
// 预览页没有数据层，唯一的分支就是这三处 —— 它们坏了预览就是假的。
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import V1 from './v1';
import V2 from './v2';

function checkStates(Page: ComponentType) {
  render(<Page />);
  expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '空' }));
  expect(screen.getByText('这个版块还没有主题')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '错误' }));
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '加载中' }));
  expect(screen.getByText('正在加载主题…')).toBeTruthy();
}

describe('方向 A · 首页预览', () => {
  it('v1：列表态有内容，空 / 错误 / 加载中都能切出来', () => {
    checkStates(V1);
  });

  it('v2：同上', () => {
    checkStates(V2);
  });

  it('游标分页：点「加载更多」后 next_cursor 变 null，按钮换成到底提示', async () => {
    render(<V1 />);
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    expect(await screen.findByText(/已经到底了/, undefined, { timeout: 2000 })).toBeTruthy();
  });
});
