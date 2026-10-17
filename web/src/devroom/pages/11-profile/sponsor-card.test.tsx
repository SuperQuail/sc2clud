import { expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SPONSOR_CHANNELS, SponsorCard } from './sponsor-card';

// D22（用户 2026-10-15 实测）：打赏面板那颗「设置我的收款码」**期望点击后就地悬浮窗**，
// 而不是跳个人设置页（旧行为：href=appPath('settings#payment-channels')，整页跳走）。
//
// 这条用例挡的是「跳走」这半个：不动的话点完人已经在设置页上了，
// 这里的 `queryByRole('dialog')` 是 null、file input 也不在 DOM 里。
it('点「设置我的收款码」就地出弹层（不跳设置页）', async () => {
  render(<SponsorCard isSelf channels={[...SPONSOR_CHANNELS]} editor={{ channels: [...SPONSOR_CHANNELS], onAdd: () => {}, onDelete: () => {} }} />);

  // 旧行为：这颗按钮是 <a href="/dev/settings#payment-channels">，点了换页
  const entry = screen.getByRole('button', { name: /设置我的收款码/ });
  expect(entry.closest('a')).toBeNull();

  fireEvent.click(entry);

  // 就地弹层：标题 + 收款码列表的行都在这一个弹层里
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(screen.getByText('赞赏与收款码')).toBeTruthy();
  // 上传控件在弹层**里面**（不是把人送到设置页才有的东西）
  expect(within(screen.getByRole('dialog')).getByText('选择收款码图片')).toBeTruthy();
});

// 别人的主页上不能有管理入口：那颗按钮是打赏入口，收款码管理只在本人态存在（D23 同一口径）。
it('看别人主页时没有「设置我的收款码」', () => {
  render(<SponsorCard isSelf={false} channels={[...SPONSOR_CHANNELS]} />);
  expect(screen.queryByText('设置我的收款码')).toBeNull();
  expect(screen.getByRole('button', { name: /赞助 TA/ })).toBeTruthy();
});
