import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { VividButton } from './button';

it('加载中不可点，并标 aria-busy', () => {
  render(<VividButton loading>提交</VividButton>);
  const btn = screen.getByRole('button', { name: '提交' });
  expect(btn.hasAttribute('disabled')).toBe(true);
  expect(btn.getAttribute('aria-busy')).toBe('true');
});

it('默认 type=button（表单里不会误提交）', () => {
  render(<VividButton>取消</VividButton>);
  expect(screen.getByRole('button', { name: '取消' }).getAttribute('type')).toBe('button');
});
