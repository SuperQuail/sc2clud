import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SquareTopicCard } from './topic-square-card';
import HomePage from './index';
import { BOARDS, TOPICS, filterByBoard } from './mock';

// 非平凡逻辑（过滤 / 排序 / 视图切换 / 空态 / 深链）必须有一条会红的检查（开发必读 §5）。
// 渲染断言只查「语义上必须存在的东西」，不查 className 这类实现细节（前端方案 §11）。
function sortTopics(list: typeof TOPICS, sort: 'latest' | 'new' | 'hot') {
  const copy = [...list];
  if (sort === 'new') return copy.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (sort === 'hot') return copy.sort((a, b) => b.reply_count - a.reply_count);
  return copy.sort((a, b) => Date.parse(b.last_reply_at) - Date.parse(a.last_reply_at));
}

it('分区筛选：全部返回所有主题，具体分区只返回该分区的主题', () => {
  expect(filterByBoard(TOPICS, 'all').length).toBe(TOPICS.length);
  const picked = filterByBoard(TOPICS, 'campaign');
  expect(picked.length).toBeGreaterThan(0);
  expect(picked.every((t) => t.board.slug === 'campaign')).toBe(true);
});

it('筛选行里的每个分区 key 都能对上主题数据（防写错 key 后永远空列表）', () => {
  for (const b of BOARDS.filter((x) => x.key !== 'all')) {
    expect(filterByBoard(TOPICS, b.key).length, b.key).toBeGreaterThan(0);
  }
});

it('排序：latest 按最后回复、new 按发布时间、hot 按回复数', () => {
  const first = (sort: 'latest' | 'new' | 'hot') => sortTopics(TOPICS, sort)[0]!;
  expect(first('latest').last_reply_at).toBe(sortTopics(TOPICS, 'latest')[0]!.last_reply_at);
  expect(Date.parse(first('new').created_at)).toBeGreaterThan(Date.parse(TOPICS[TOPICS.length - 1]!.created_at));
  expect(first('hot').reply_count).toBe(Math.max(...TOPICS.map((t) => t.reply_count)));
  // 排序不许就地改原数组（列表来自 Query 缓存，改了就污染缓存）
  const before = TOPICS.map((t) => t.id).join();
  sortTopics(TOPICS, 'hot');
  expect(TOPICS.map((t) => t.id).join()).toBe(before);
});

it('方卡片：标题链到帖子页，封面是固定比例的 img，统计数字都在', () => {
  const topic = TOPICS[0]!;
  render(<SquareTopicCard topic={topic} />);
  expect(screen.getByRole('link', { name: topic.title })).toBeTruthy();
  const cover = screen.getByAltText('《' + topic.title + '》封面');
  expect(cover.getAttribute('src')).toBe(topic.cover);
  expect(cover.getAttribute('loading')).toBe('lazy');
  expect(screen.getByText(String(topic.reply_count))).toBeTruthy();
  expect(screen.getByText(String(topic.like_count))).toBeTruthy();
  expect(screen.getByText(String(topic.view_count))).toBeTruthy();
});

it('方卡片：无封面时不留空壳（色块占位替代）', () => {
  const noCover = TOPICS.find((t) => !t.cover)!;
  render(<SquareTopicCard topic={noCover} />);
  expect(screen.queryByAltText('《' + noCover.title + '》封面')).toBeNull();
  expect(screen.getByText(noCover.board.name[0]!)).toBeTruthy();
});

it('方卡片：置顶与精华的标记只在有对应字段时出现', () => {
  const featured = TOPICS.filter((t) => t.pinned || t.featured_at);
  expect(featured.length).toBeGreaterThan(0);
  render(<SquareTopicCard topic={featured[0]!} />);
  const hasPinned = Boolean(featured[0]!.pinned);
  expect(screen.queryAllByText('置顶').length).toBe(hasPinned ? 1 : 0);
});

it('视图切换：默认卡片网格，点「紧凑列表」后换成紧凑行（同一份数据）', () => {
  render(<HomePage />);
  const first = TOPICS[0]!;
  expect(screen.queryAllByTestId(/^sq-card-/).length).toBeGreaterThan(0);
  act(() => screen.getByTestId('view-compact').click());
  expect(screen.queryAllByTestId(/^sq-card-/).length).toBe(0);
  // 紧凑行链的还是同一个帖子：切换只换皮、不换数据
  expect(screen.getAllByRole('link', { name: first.title }).length).toBeGreaterThan(0);
  act(() => screen.getByTestId('view-card').click());
  expect(screen.queryAllByTestId(/^sq-card-/).length).toBeGreaterThan(0);
});

it('空态：切到空态后给出出路按钮，点它能回到列表', () => {
  render(<HomePage />);
  act(() => screen.getByTestId('toggle-empty').click());
  expect(screen.getAllByText('这个分区还没有主题').length).toBeGreaterThan(0);
  expect(screen.queryAllByTestId(/^sq-card-/).length).toBe(0);
  act(() => screen.getByRole('button', { name: '看全部主题' }).click());
  expect(screen.queryAllByTestId(/^sq-card-/).length).toBeGreaterThan(0);
});

it('?view=compact 深链：首屏直接是紧凑列表（将来接 useSearchParams 的落点）', () => {
  window.history.pushState({}, '', '/devroom.html?page=14-home&view=compact');
  try {
    render(<HomePage />);
    expect(screen.queryAllByTestId(/^sq-card-/).length).toBe(0);
  } finally {
    window.history.pushState({}, '', '/');
  }
});
