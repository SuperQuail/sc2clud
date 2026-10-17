import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AdminShell, type AdminSelf } from './shell';

// D57：用户在生产上找不到退出入口——它埋在 /settings 的 AccountPanel 里，管理员从不往那儿想。
// 现在后台右上卡直接给一颗「退出登录」（有登录者才画）：点了必须命中宿主回调。
const ME: AdminSelf = { nickname: '虚空辉光舰', handle: 'demo-voidray', role: { key: 'creator', name: '认证创作者' }, avatar: null };

it('右上卡有「退出登录」，点了命中宿主', () => {
  const onLogout = vi.fn();
  render(
    <AdminShell screen='users' onScreen={() => {}} me={ME} meExtra={[]} onLogout={onLogout}>
      <div>屏</div>
    </AdminShell>,
  );
  fireEvent.click(screen.getByTestId('admin-logout'));
  expect(onLogout).toHaveBeenCalledTimes(1);
});

it('没给 onLogout 时不画那颗（不放假的退出）', () => {
  render(
    <AdminShell screen='users' onScreen={() => {}} me={ME} meExtra={[]}>
      <div>屏</div>
    </AdminShell>,
  );
  expect(screen.queryByTestId('admin-logout')).toBeNull();
});
