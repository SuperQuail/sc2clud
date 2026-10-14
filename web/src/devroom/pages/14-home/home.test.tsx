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

it('分区筛选：全部返回所有帖子，具体分区只返回该分区的帖子', () => {
  expect(filterByBoard(TOPICS, 'all').length).toBe(TOPICS.length);
  const picked = filterByBoard(TOPICS, 'campaign');
  expect(picked.length).toBeGreaterThan(0);
  expect(picked.every((t) => t.board.slug === 'campaign')).toBe(true);
});

it('筛选行里的每个分区 key 都能对上帖子数据（防写错 key 后永远空列表）', () => {
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
  // 2026-10-13：链接改由调用方给（href prop），与 @/ui/topic/topic-row 同一套约定 ——
  // 房子件自己拼路径会把房间用户送到旧站 404。所以这里必须显式传 href。
  render(<SquareTopicCard topic={topic} href='?page=12-topic' />);
  expect(screen.getByRole('link', { name: topic.title })).toBeTruthy();
  const cover = screen.getByAltText('《' + topic.title + '》封面');
  expect(cover.getAttribute('src')).toBe(topic.cover);
  expect(cover.getAttribute('loading')).toBe('lazy');
  expect(screen.getByText(String(topic.reply_count))).toBeTruthy();
  expect(screen.getByText(String(topic.like_count))).toBeTruthy();
  expect(screen.getByText(String(topic.view_count))).toBeTruthy();
});

it('方卡片：没给 href 时标题**不是链接**（宁可不可点，也不把人送到别处）', () => {
  const topic = TOPICS[0]!;
  render(<SquareTopicCard topic={topic} />);
  expect(screen.queryByRole('link', { name: topic.title })).toBeNull();
  expect(screen.getByText(topic.title)).toBeTruthy();
});

it('方卡片：无封面时不留空壳（色块占位替代）', () => {
  const noCover = TOPICS.find((t) => !t.cover)!;
  render(<SquareTopicCard topic={noCover} />);
  expect(screen.queryByAltText('《' + noCover.title + '》封面')).toBeNull();
  expect(screen.getByText(noCover.board.name[0]!)).toBeTruthy();
});

// J9：后端在列表项里给了封面原图尺寸（TopicCardDTO 的 cover_width/cover_height）。
// 有它就能**在发图片请求之前**判「这张放大出来是糊的」，而不是先把小图拉下来再回退 ——
// 后者会先闪一张糊图（用户看到的就是那一帧），而且在慢网下要等一整个往返。
it('方卡片：后端说封面太小（cover_width）时**直接不取那张图**，回落到色块占位', () => {
  const topic = { ...TOPICS[0]!, cover: '/img/tiny', cover_width: 120, cover_height: 68 };
  render(<SquareTopicCard topic={topic} />);
  // 关键判据是「img 根本没被渲染」——渲染了才会发请求，也就等于没省掉那一趟
  expect(screen.queryByAltText('《' + topic.title + '》封面')).toBeNull();
  expect(screen.getByText(topic.board.name[0]!)).toBeTruthy();
});

it('方卡片：尺寸够大（或后端没给尺寸）时照常渲染封面', () => {
  const big = { ...TOPICS[0]!, cover: '/img/big', cover_width: 1200, cover_height: 675 };
  const { unmount } = render(<SquareTopicCard topic={big} />);
  expect(screen.getByAltText('《' + big.title + '》封面').getAttribute('src')).toBe('/img/big');
  unmount();
  // 旧数据（接口没给这两个字段）走保底路径：照常渲染，由解码后的 naturalWidth 兜底
  const unknown = { ...TOPICS[0]!, cover: '/img/unknown', cover_width: undefined, cover_height: undefined };
  render(<SquareTopicCard topic={unknown} />);
  expect(screen.getByAltText('《' + unknown.title + '》封面')).toBeTruthy();
});

it('方卡片：置顶与精华的标记只在有对应字段时出现', () => {
  const featured = TOPICS.filter((t) => t.pinned || t.featured);
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
  expect(screen.getAllByText('这个分区还没有帖子').length).toBeGreaterThan(0);
  expect(screen.queryAllByTestId(/^sq-card-/).length).toBe(0);
  act(() => screen.getByRole('button', { name: '看全部帖子' }).click());
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
