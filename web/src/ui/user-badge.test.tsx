import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { UserBadge } from './user-badge';

it('渲染昵称、等级、角色与头衔', () => {
  render(
    <UserBadge
      user={{
        handle: 'tangtian',
        nickname: '唐天',
        level: 8,
        role: { key: 'moderator', name: '版主' },
        title: { name: '执政官', color: '#2563eb' },
      }}
      showHandle
    />,
  );
  // Ring UI Avatar 的 fallback 会把昵称渲染进 SVG 的 <title>/<tspan>，所以这里用 getAllBy
  expect(screen.getAllByText('唐天').length).toBeGreaterThan(0);
  expect(screen.getByText('Lv.8')).toBeTruthy();
  expect(screen.getByText('版主')).toBeTruthy();
  expect(screen.getByText('执政官')).toBeTruthy();
  expect(screen.getByText('@tangtian')).toBeTruthy();
});

it('没有等级/头衔时不渲染空壳', () => {
  render(<UserBadge user={{ handle: 'u', nickname: '无名' }} />);
  expect(screen.getAllByText('无名').length).toBeGreaterThan(0);
  expect(screen.queryByText(/^Lv\./)).toBeNull();
});
