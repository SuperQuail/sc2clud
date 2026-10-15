import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { GroupsScreen } from './groups';
import type { AdminGroup, AdminGroupMember } from '@/lib/api/groups';

// 用户组屏（D38）的三条屏内行为。组员与判定的**生效即时性**在后端用真库测（group_acl_test.go），
// 这里只钉「屏上点了什么动作、发生了什么」。

const group: AdminGroup = {
  id: 'g0000000-0000-4000-8000-000000000001',
  key: 'va',
  name: '视觉组',
  description: '',
  member_count: 2,
  created_at: '2026-09-01T02:00:00Z',
  updated_at: '2026-09-01T02:00:00Z',
};

const members: AdminGroupMember[] = [
  { user_id: 'u1', handle: 'demo-admin', nickname: '示范管理员', added_at: '2026-09-01T02:00:00Z' },
  { user_id: 'u2', handle: 'demo-creator', nickname: '示范创作者', added_at: '2026-09-02T02:00:00Z' },
];

function renderOpts(onRemove: (userId: string) => void = () => {}, onSave: (...a: unknown[]) => void = () => {}) {
  render(
    <GroupsScreen
      groups={[group]}
      groupId={group.id}
      onSelect={() => {}}
      onCreate={() => {}}
      onSave={onSave}
      onDelete={() => {}}
      members={members}
      candidates={[{ id: 'u9', username: 'demo-new', nickname: '新朋友' }]}
      onAddMember={() => {}}
      onRemoveMember={onRemove}
      canManage
    />,
  );
}

it('移出成员：点「移出」把那一行的 user_id 发给宿主（判定当场生效，屏上不做二次弹层）', () => {
  const seen: string[] = [];
  renderOpts((userId) => seen.push(userId));
  const buttons = screen.getAllByRole('button', { name: '移出' });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]!);
  expect(seen).toEqual(['u1']);
});

it('改组资料：草稿标「未保存」，点保存把 name/description 发上去', () => {
  const seen: Array<{ id: string; patch: { name: string; description: string } }> = [];
  renderOpts(() => {}, (id, patch) => seen.push({ id, patch: patch as { name: string; description: string } }));
  const name = screen.getByLabelText('名称');
  fireEvent.change(name, { target: { value: '视觉组二' } });
  expect(screen.getByText('未保存')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '保存改动' }));
  expect(seen).toEqual([{ id: group.id, patch: { name: '视觉组二', description: '' } }]);
});

it('空组给一句「还没有成员」，不渲染空名单占位破图', () => {
  render(
    <GroupsScreen
      groups={[group]}
      groupId={group.id}
      onSelect={() => {}}
      onCreate={() => {}}
      onSave={() => {}}
      onDelete={() => {}}
      members={[]}
      candidates={[]}
      onAddMember={() => {}}
      onRemoveMember={() => {}}
      canManage
    />,
  );
  expect(screen.getByText('这个组还没有成员。')).toBeTruthy();
});
