import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoardCover, BoardRail, type BoardSummary } from './board-rail';

// D3（2026-10-14 用户实测：「左侧分区列表没有任何图片」）的渲染侧。
//
// 两件事必须同时成立，否则「补上封面位」等于把空白换了个位置：
//   ① 后端给了封面（cover_hash 非空）时**真的画图**（旧行为：BoardRail 里根本没有 <img>）；
//   ② 后端没给（真站五个分区现在**全是空串**，迁移没迁封面）时落一个**稳定的占位**，
//      而不是空白 —— 稳定 = 同一个 slug 每次同一个色相。
//
// 字段名是后端 BoardDTO 的 cover_hash（裸哈希），不是设计稿的 cover（路径）。

const BOARDS: BoardSummary[] = [
  // 第一条带 today_count（>0），第二条为 0 —— 「今日 N」那条用例就靠这两个值分档：
  // **0 不画**（一排 0 只是噪音），有新增才画，与分区页那句「· 今日 N」同一口径。
  { slug: 'custom-campaign', name: '自制战役', cover_hash: 'abc123', description: '玩家自制战役与地图', topic_count: 10, today_count: 3 },
  { slug: 'emperor', name: '皇帝区', cover_hash: '', description: '', topic_count: 0, today_count: 0 },
];

// **View 里不出现 react-router**（房间不在 RouterProvider 里，import 了它就渲染不了）：
// 所以这里连测试也不套 MemoryRouter —— 缺省落地件就是普通 <a href>，产品宿主自己传 Link。
function renderRail(current?: string) {
  return render(<BoardRail boards={BOARDS} current={current} />);
}

// 封面图是装饰性的（alt=''），所以它的 role 是 presentation —— 按 DOM 找，不按 role=img 找。
it('有封面的分区画图，图的地址是 /img/<裸哈希>', () => {
  const { container } = renderRail();
  const img = container.querySelector('img');
  expect(img?.getAttribute('src')).toBe('/img/abc123');
  expect(img?.getAttribute('loading')).toBe('lazy');
});

it('没有封面的分区落稳定占位：首字 + slug 定的色相（不是空白）', () => {
  const { container } = render(<BoardCover slug='emperor' name='皇帝区' hash='' />);
  const box = container.firstElementChild as HTMLElement;
  expect(box.textContent).toBe('皇');
  // 同一个 slug 两次渲染必须是同一个色（色相由 slug 算，与用户头像同一套公式）
  const again = render(<BoardCover slug='emperor' name='皇帝区' hash='' />);
  expect((again.container.firstElementChild as HTMLElement).getAttribute('style')).toBe(box.getAttribute('style'));
  // jsdom 把 hsl() 归一化成 rgb()（就绪：比对颜色值要先归一化，不能比字符串原文）
  expect(box.getAttribute('style')).toMatch(/^background: rgb\(/);
  // 注：色相桶只有 6 个，而这套取色公式（与 @/ui/user/avatar 逐字相同）在 10 字以上的 key 上会撞桶
  // —— 真站五个分区里有三个撞到同一个桶。占位块本身仍然「有字有底色」，所以这里不断言「两两不同」。
  // 要真正打散得动 UserAvatar 的公式（全站头像会一起变色），不在 D3 的范围里。
});

it('今日 N（用户 2026-10-15 拍板「可以加」）：有新增才画，0 不画', () => {
  renderRail();
  // 有新增的那一行画「今日 3」；0 的那一行一个字都不出现
  expect(screen.getByText('今日 3')).toBeTruthy();
  expect(screen.getAllByText(/^今日 /)).toHaveLength(1);
});

it('每个分区都有一行：链到 /b/<slug>、当前分区标 aria-current', () => {
  renderRail('emperor');
  expect(screen.getByRole('link', { name: /自制战役/ }).getAttribute('href')).toBe('/b/custom-campaign');
  expect(screen.getByRole('link', { name: /皇帝区/ }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: /自制战役/ }).getAttribute('aria-current')).toBeNull();
});
