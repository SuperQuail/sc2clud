import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { UserBadge } from './user-badge';

const ME = {
  handle: 'tangtian',
  nickname: '唐天',
  role: { key: 'moderator', name: '版主' },
  title: { name: '执政官', color: '#2563eb' },
};

it('渲染昵称、权限与头衔（没有等级）', () => {
  render(<UserBadge user={ME} showHandle />);
  expect(screen.getByText('唐天')).toBeTruthy();
  expect(screen.getByText('版主')).toBeTruthy();
  expect(screen.getByText('执政官')).toBeTruthy();
  expect(screen.getByText('@tangtian')).toBeTruthy();
  expect(screen.queryByText(/^Lv\./)).toBeNull();
});

it('badges=none 时不渲染权限与头衔', () => {
  render(<UserBadge user={ME} badges='none' />);
  expect(screen.queryByText('版主')).toBeNull();
  expect(screen.queryByText('执政官')).toBeNull();
});

it('没有权限/头衔时不渲染空壳', () => {
  render(<UserBadge user={{ handle: 'u', nickname: '无名' }} />);
  expect(screen.getByText('无名')).toBeTruthy();
});
