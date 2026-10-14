import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
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

// D19：关注作者。三态**全部由宿主判**（组件不自己认路由、不自己认会话）：
//   自己看自己 → 不给 follow 这个 prop（不画）；未登录 → 给 loginHref（引导登录）；登录 → 给 following + onToggle。
// 「态以服务端回执为准」在这一层的含义是：按钮上那个「已关注」是**喂进来的**，组件自己不翻转。
it('D19：作者卡的关注按钮点了回调（态不自己翻，等宿主拿回执喂回来）', () => {
  const onToggle = vi.fn();
  render(<AuthorCard author={AUTHOR} profileHref='/u/demo-admin' follow={{ following: false, onToggle }} />);
  fireEvent.click(screen.getByRole('button', { name: '关注' }));
  expect(onToggle).toHaveBeenCalledTimes(1);
  // 还是「关注」：组件没有本地翻转
  expect(screen.getByRole('button', { name: '关注' })).toBeTruthy();
});

it('D19：已关注由回执给（following=true 就画「已关注」）', () => {
  render(<AuthorCard author={AUTHOR} profileHref='/u/demo-admin' follow={{ following: true, onToggle: () => {} }} />);
  expect(screen.getByRole('button', { name: '已关注' })).toBeTruthy();
});

it('D19：未登录 → 关注那颗是去登录的链接（引导登录）', () => {
  render(
    <AuthorCard
      author={AUTHOR}
      profileHref='/u/demo-admin'
      follow={{ following: false, onToggle: () => {}, loginHref: '/login?next=/u/demo-admin' }}
    />,
  );
  const link = screen.getByRole('link', { name: '登录后关注' });
  expect(link.getAttribute('href')).toBe('/login?next=/u/demo-admin');
});

it('D19：自己看自己（宿主不传 follow）→ 一颗关注按钮都没有', () => {
  render(<AuthorCard author={AUTHOR} profileHref='/u/demo-admin' />);
  expect(screen.queryByRole('button', { name: /关注/ })).toBeNull();
});
