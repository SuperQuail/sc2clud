import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { UsersScreen, type UsersFilter, type UsersCounts } from './users';
import { ApiError } from '@/lib/api/errors';
import type { AdminUser, AdminUserDetail, Role, Title } from '@/lib/api/admin';

// D29 的手工激活：站点关掉自动激活后，管理员这一屏是**唯一**的激活入口。
// 旧行为下这条断言必红：这一屏只有「停用 / 解封」，没有任何办法把一个人的 activated_at 点亮，
// 于是「等管理员激活」这条路在界面上根本走不到底。
//
// FIX-USERS：这一屏同时要回答「一共多少人、共几页」并让翻页真的发请求。
// 旧行为下前三条断言必红 —— 屏上只有「本页用户 = users.length」，页码是本地 state 自己加一，
// 点了「下一页」既不换数据也没人知道该去取第几页。

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

const COUNTS: UsersCounts = { total: 137, banned: 4, pending_activation: 9, email_unverified: 12 };

function renderScreen(u: AdminUser, over: { page?: number; canNext?: boolean; onPage?: (p: number) => void; onReset?: ReturnType<typeof vi.fn> } = {}) {
  const onActivate = vi.fn();
  const onPage = over.onPage ?? vi.fn();
  const onReset = over.onReset ?? vi.fn();
  const filter: UsersFilter = { q: '', status: 'all', role: 'all' };
  render(
    <UsersScreen
      users={[u]}
      detail={detail(u)}
      onSelect={() => {}}
      counts={COUNTS}
      page={over.page ?? 1}
      canNext={over.canNext ?? true}
      onPage={onPage}
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
      onResetPassword={onReset}
    />,
  );
  return { onActivate, onPage, onReset };
}

// ── D56 管理员重置密码 ────────────────────────────────────────────────

it('D56：重置密码留空提交 → onReset(id, "")，一次性临时密码只在弹层里给一次', async () => {
  const onReset = vi.fn().mockResolvedValue({ password: 't3mp7kqkmrz4', revoked: 2 });
  renderScreen(user({ activated_at: '2026-10-14T12:00:00Z' }), { onReset });
  // 行内与右栏各有入口；点第一颗即可
  fireEvent.click(screen.getAllByRole('button', { name: '重置密码' })[0]!);
  fireEvent.click(screen.getByTestId('pw-reset-submit'));
  expect(await screen.findByTestId('pw-reset-once')).toBeTruthy();
  const once = screen.getByTestId('pw-reset-once');
  expect(once.textContent).toContain('t3mp7kqkmrz4');
  expect(once.textContent).toContain('只显示这一次');
  expect(onReset).toHaveBeenCalledWith('u-1', '');
  // 出了结果不关弹层（临时密码关掉就再也拿不回），提交键被「完成」替代
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
  expect(screen.queryByTestId('pw-reset-submit')).toBeNull();
});

it('D56：显式密码原文上送，不出回显位', async () => {
  const onReset = vi.fn().mockResolvedValue({ revoked: 0 });
  renderScreen(user({}), { onReset });
  fireEvent.click(screen.getAllByRole('button', { name: '重置密码' })[0]!);
  const box = await screen.findByRole('textbox', { name: /新密码/ });
  fireEvent.change(box, { target: { value: 'admin-set-2026' } });
  fireEvent.click(screen.getByTestId('pw-reset-submit'));
  expect(await screen.findByTestId('pw-reset-once-explicit')).toBeTruthy();
  expect(onReset).toHaveBeenCalledWith('u-1', 'admin-set-2026');
  expect(screen.queryByTestId('pw-reset-once')).toBeNull();
});

it('D56：失败不关弹层，字段理由就近可见（D48 同策略）', async () => {
  const onReset = vi.fn().mockRejectedValue(new ApiError(400, 'common.invalid', '参数无效', undefined, { password: '密码长度必须是 8-128 个字节' }));
  renderScreen(user({}), { onReset });
  fireEvent.click(screen.getAllByRole('button', { name: '重置密码' })[0]!);
  fireEvent.click(screen.getByTestId('pw-reset-submit'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('8-128');
  expect(screen.getByTestId('pw-reset-submit')).toBeTruthy();
});

// 无 user.ban 既不画行内也不画右栏入口（权限的口径与其它动作一致）
it('D56：canBan=false 不画任何重置入口', () => {
  const onReset = vi.fn();
  render(
    <UsersScreen
      users={[user({})]}
      detail={null}
      onSelect={() => {}}
      counts={COUNTS}
      page={1}
      canNext={false}
      onPage={() => {}}
      filter={{ q: '', status: 'all', role: 'all' }}
      onFilterChange={() => {}}
      roles={[] as Role[]}
      titles={[] as Title[]}
      canBan={false}
      canAssignRole={false}
      canGrantTitle={false}
      onBan={() => {}}
      onActivate={() => {}}
      onRevokeSessions={() => {}}
      onSetRole={() => {}}
      onGrantTitle={() => {}}
      onResetPassword={onReset}
    />,
  );
  expect(screen.queryByRole('button', { name: '重置密码' })).toBeNull();
});

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

it('第一格显示的是总人数（不是本页条数），并给出共几页', () => {
  renderScreen(user({}));
  // 137 人 / 每页 20 → 7 页；137 必须是服务端给的整个筛选结果集
  expect(screen.getByTestId('users-page-info').textContent).toContain('共 137 人');
  expect(screen.getByTestId('users-page-info').textContent).toContain('第 1 / 7 页');
});

it('三根轴的计数也显示全量（不是本页数）', () => {
  renderScreen(user({}));
  expect(screen.getByTestId('users-stat-banned').textContent).toContain('4');
  expect(screen.getByTestId('users-stat-pending').textContent).toContain('9');
  expect(screen.getByTestId('users-stat-unverified').textContent).toContain('12');
});

it('点「下一页」把页码交给宿主（页码只由宿主改，屏里不自己 +1）', () => {
  const { onPage } = renderScreen(user({}), { page: 1, canNext: true });
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(onPage).toHaveBeenCalledWith(2);
});

it('第一页「上一页」禁用；没有下一页时「下一页」禁用（游标栈到底）', () => {
  renderScreen(user({}), { page: 1, canNext: false });
  expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true);
});

it('跳到某一页也交给宿主（游标栈只支持已经到过的下一页，超范围就地拒绝）', () => {
  const { onPage } = renderScreen(user({}), { page: 2, canNext: true });
  const box = screen.getByRole('textbox', { name: /跳页/ });
  fireEvent.change(box, { target: { value: '3' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onPage).toHaveBeenCalledWith(3);
  // 越界（99 页）不发请求
  fireEvent.change(box, { target: { value: '99' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onPage).toHaveBeenCalledTimes(1);
});
