import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AdminShell, type AdminSelf } from './shell';

// D14：管理页右上角那张「当前管理员」卡以前写死 DevRoom 的 mock（示范管理员 @demo-admin / 管理员），
// 于是**每个登录者看到的都是同一个人** —— 界面上显示一个不存在的管理员，出问题时人会去找他。
// 验收：① 显示真 session 的昵称 / @handle / 角色；② **拿不到 session 时整块不画**（不是显示假的）。
//
// 判据钉在「昵称在不在 + demo-admin 在不在」上，不钉任何 mock 文案。

const ME: AdminSelf = { nickname: '虚空辉光舰', handle: 'demo-voidray', role: { key: 'creator', name: '认证创作者' }, avatar: null };

function renderShell(me: AdminSelf | null | undefined) {
  render(
    <AdminShell screen='users' onScreen={() => {}} me={me} meExtra={[]}>
      <div>屏内容</div>
    </AdminShell>,
  );
}

it('喂了真 session：显示的是这个人（昵称 / @handle / 角色）', () => {
  renderShell(ME);
  expect(screen.getByText('虚空辉光舰')).toBeTruthy();
  expect(screen.getByText('@demo-voidray')).toBeTruthy();
  expect(screen.getByText('认证创作者')).toBeTruthy();
});

it('拿不到 session：整块不画，绝不显示示例用户', () => {
  renderShell(null);
  expect(screen.queryByText('示范管理员')).toBeNull();
  expect(screen.queryByText('@demo-admin')).toBeNull();
  expect(screen.queryByText('当前管理员')).toBeNull();
  // 也不留一片沉默：说明它为什么空着（空白与「这个人没有名字」在界面上长得一样）
  expect(screen.getByTestId('admin-self-missing')).toBeTruthy();
  expect(screen.getByText('屏内容')).toBeTruthy();
});

it('没给角色时只少一枚徽标，不编一个出来', () => {
  renderShell({ ...ME, role: null });
  expect(screen.getByText('虚空辉光舰')).toBeTruthy();
  expect(screen.queryByText('管理员')).toBeNull();
});
