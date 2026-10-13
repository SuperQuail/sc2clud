import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ProfilePage from './index';

// 本人 / 别人这一对必须在**页面这一层**验（开发必读里那条教训：控件是共用的 ≠ 这一页会渲染它）。
// 看别人主页时，换头像 / 设置 / 改密码 / 退出登录**一行都不该出现**——就在这里锁住。
function withQuery(query: string, run: () => void) {
  const before = location.search;
  window.history.pushState({}, '', '/devroom.html' + query);
  try { run(); } finally { window.history.pushState({}, '', '/devroom.html' + before); }
}

it('本人主页：有设置标签，切过去能看到改密码/退出登录/上传头像', () => {
  withQuery('?page=11-profile', () => {
    render(<ProfilePage />);
    expect(screen.getByTestId('change-avatar')).toBeTruthy(); // hero 上的入口
    expect(screen.getByTestId('icon-tab-settings')).toBeTruthy();
    act(() => screen.getByTestId('icon-tab-settings').click());
    expect(screen.getByTestId('password-save')).toBeTruthy();
    expect(screen.getByTestId('logout')).toBeTruthy();
    expect(document.querySelectorAll('input[type=file]').length).toBe(1);
  });
});

it('看别人主页：这些入口一行都不出现（账号面板没有挂载点）', () => {
  withQuery('?page=11-profile&sponsor=other', () => {
    const { container } = render(<ProfilePage />);
    expect(screen.queryByTestId('icon-tab-settings')).toBeNull();
    expect(screen.queryByTestId('change-avatar')).toBeNull();
    expect(screen.queryByTestId('logout')).toBeNull();
    expect(screen.queryByTestId('password-save')).toBeNull();
    // 连上传控件本身都不在 DOM 里（这就是"一行都不出现"的硬证据）
    expect(container.querySelectorAll('input[type=file]').length).toBe(0);
    // 「更换封面」仍在（看别人主页也有意义），说明不是整块hero挂了
    expect(screen.getByTestId('change-cover')).toBeTruthy();
  });
});

it('退出登录：点了出现可观察结果（未登录横幅 + 账号动作收起）', () => {
  withQuery('?page=11-profile', () => {
    render(<ProfilePage />);
    act(() => screen.getByTestId('icon-tab-settings').click());
    act(() => screen.getByTestId('logout').click());
    expect(screen.getByTestId('logged-out-banner')).toBeTruthy();
    // 账号动作收起：只剩一条去登录的路
    expect(screen.queryByTestId('logout')).toBeNull();
    expect(screen.queryByTestId('password-save')).toBeNull();
    expect(screen.getByRole('link', { name: '去登录' })).toBeTruthy();
    // 还有一条能回到演示态的路，否则这一页没法继续走查
    act(() => screen.getByTestId('demo-relogin').click());
    expect(screen.queryByTestId('logged-out-banner')).toBeNull();
    expect(screen.getByTestId('logout')).toBeTruthy();
  });
});
