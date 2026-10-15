import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { UsersScreen, type UsersFilter } from './users';
import type { AdminUser, AdminUserDetail, Role, Title } from '@/lib/api/admin';

// D29 的手工激活：站点关掉自动激活后，管理员这一屏是**唯一**的激活入口。
// 旧行为下这条断言必红：这一屏只有「停用 / 解封」，没有任何办法把一个人的 activated_at 点亮，
// 于是「等管理员激活」这条路在界面上根本走不到底。

function user(over: Partial<AdminUser>): AdminUser {
  return {
    id: 'u-1', username: 'waiting', nickname: '等激活的人', email: 'w@example.com',
    role: { key: 'user', name: '普通用户', badge_color: '' },
    status: 'active', email_verified_at: null, activated_at: null,
    trusted: false, level: 0,
    created_at: '2026-10-14T10:00:00Z', last_login_at: null, topic_count: 0, reply_count: 0,
    ...over,
  };
}

const detail = (u: AdminUser): AdminUserDetail => ({ ...u, sanctions: [], user_permissions: [], user_titles: [] });

function renderScreen(u: AdminUser) {
  const onActivate = vi.fn();
  const filter: UsersFilter = { q: '', status: 'all', role: 'all' };
  render(
    <UsersScreen
      users={[u]}
      detail={detail(u)}
      onSelect={() => {}}
      total={1}
      filter={filter}
      onFilterChange={() => {}}
      roles={[] as Role[]}
      titles={[] as Title[]}
      canBan
      canAssignRole={false}
      canGrantTitle={false}
      onBan={() => {}}
      onActivate={onActivate}
      onRevokeSessions={() => {}}
      onSetRole={() => {}}
      onGrantTitle={() => {}}
    />,
  );
  return { onActivate };
}

it('未激活账号有「激活账号」，点了走 onActivate（只写 activated_at）', () => {
  const { onActivate } = renderScreen(user({}));
  const button = screen.getByRole('button', { name: /激活账号/ });
  fireEvent.click(button);
  // 二次确认里必须说清「手工激活 ≠ 邮箱验证」，否则管理员会以为顺手把邮箱也验了
  expect(screen.getByText(/不改/)).toBeTruthy();
  // 两处同名：左栏那颗（已点开）+ 确认弹层里那颗。弹层是最后渲染的，取最后一个。
  const confirmButtons = screen.getAllByRole('button', { name: '激活账号' });
  fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
  expect(onActivate).toHaveBeenCalledWith(['u-1']);
});

it('已激活的账号没有那颗按钮（激活是单向的，不是开关）', () => {
  renderScreen(user({ activated_at: '2026-10-14T12:00:00Z' }));
  expect(screen.queryByRole('button', { name: /激活账号/ })).toBeNull();
});
