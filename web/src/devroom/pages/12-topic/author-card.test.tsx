import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AuthorCard } from './author-card';
import type { TopicAuthor } from './types';

// 作者卡的两条口径（缺陷清单 D16 / D17），都在**没有别的路径能出错**的这一层验：
// 房间与真站渲染的是同一个 AuthorCard，所以这里红一次就等于两处都红。
const AUTHOR: TopicAuthor = {
  handle: 'demo-admin',
  nickname: '示范管理员',
  avatar: '',
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
  bio: '战役作者，负责关卡设计与剧情。',
  level: 27,
  exp: 640,
  exp_max: 1000,
  topic_count: 86,
  like_received: 12480,
  joined_at: '2024 年 3 月',
};

// D16：没有头衔时**不画那一枚**。旧行为是 author.title ?? { name: '无头衔' } —— 编一个不存在的头衔，
// 而且全站另外四处（comment-item / topic-row / user-badge / profile-hero）都是「没有就不画」。
it('D16：没有头衔就不画头衔徽标，也不编「无头衔」这个假头衔', () => {
  const { container } = render(<AuthorCard author={{ ...AUTHOR, title: null }} profileHref='/u/demo-admin' />);
  expect(container.textContent).not.toContain('无头衔');
});

// 有头衔时照画（免得「不画」被实现成「永远不画」）
it('D16：有头衔时照画', () => {
  render(<AuthorCard author={AUTHOR} profileHref='/u/demo-admin' />);
  expect(screen.getAllByText('执政官').length).toBeGreaterThan(0);
});

// D17：昵称/角色徽标居中，头衔那一行却是左对齐 —— 同一列里的混排。这条断言钉住「同一条中轴」。
it('D17：头衔那一行与头像/昵称/角色同一条中轴（居中）', () => {
  render(<AuthorCard author={AUTHOR} profileHref='/u/demo-admin' />);
  expect(screen.getByTestId('author-title-row').className).toContain('justify-center');
});
