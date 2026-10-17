import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchPanel } from './search-panel';
import { searchTopics, searchUsers, toTopicRow, type SearchUser } from './data';
import { TOPICS } from '../14-home/mock';

// 搜索这一屏的非平凡逻辑：两档筛选 + 四态。断言查「语义上必须存在的东西」，不查 className。

describe('data（两档筛选）', () => {
  it('帖子：标题/正文命中才返回；空词与乱词都返回 []', () => {
    const hit = searchTopics('战役');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((t) => (t.title + ' ' + t.excerpt).includes('战役'))).toBe(true);
    expect(searchTopics('')).toEqual([]);
    expect(searchTopics('这个词一定搜不到')).toEqual([]);
  });

  it('用户：handle 与昵称都走**前缀**匹配（不是包含匹配）', () => {
    expect(searchUsers('demo-mar').map((u) => u.handle)).toEqual(['demo-marine']);
    expect(searchUsers('陆战').map((u) => u.nickname)).toEqual(['陆战队员', '陆战队员']);
    expect(searchUsers('marine')).toEqual([]); // 包含但不前缀 → 不算命中（与后端 SearchSQL 一致）
  });

  it('重名的两位都带 ambiguous=true —— 界面靠 @handle 区分', () => {
    const dup = searchUsers('陆战');
    expect(dup.length).toBe(2);
    expect(dup.every((u) => u.ambiguous)).toBe(true);
    expect(new Set(dup.map((u) => u.handle)).size).toBe(2);
  });

  it('帖子行映射：计数/时间/href 都带上，href 由调用方给', () => {
    const row = toTopicRow(TOPICS[0]!, '?page=12-topic');
    expect(row.id).toBe(TOPICS[0]!.id);
    expect(row.replies).toBe(TOPICS[0]!.reply_count);
    expect(row.views).toBe(TOPICS[0]!.view_count);
    expect(row.href).toBe('?page=12-topic');
    expect(row.tags?.[0]?.text).toBeTruthy();
  });
});

const noop = () => {};
const base = {
  q: '战役',
  onQChange: noop,
  onSubmit: noop,
  onClear: noop,
  tab: 'topics' as const,
  onTabChange: noop,
  state: 'idle' as const,
  topics: [],
  users: [],
};

it('加载态：aria-busy 有、骨架有、空态文案不出现（三种态不许同时露脸）', () => {
  render(<SearchPanel {...base} state='loading' />);
  expect(screen.getByLabelText('正在搜索').getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByText('没有匹配的帖子')).toBeNull();
  expect(screen.queryByText('搜帖子，或搜人')).toBeNull();
});

it('空态：给出「查的是什么」与一条出路（清除搜索）', () => {
  const onClear = vi.fn();
  render(<SearchPanel {...base} state='ready' topics={[]} onClear={onClear} />);
  expect(screen.getByText('没有匹配的帖子')).toBeTruthy();
  act(() => screen.getByRole('button', { name: '清除搜索' }).click());
  expect(onClear).toHaveBeenCalledTimes(1);
});

it('结果态（帖子档）：走的是全站同一个主题行，链接由调用方给', () => {
  const topic = TOPICS[0]!;
  render(<SearchPanel {...base} state='ready' topics={[toTopicRow(topic, '?page=12-topic')]} />);
  expect(screen.getByRole('link', { name: topic.title }).getAttribute('href')).toBe('?page=12-topic');
  expect(screen.getByText(new RegExp(String(topic.reply_count) + ' 回复 · ' + String(topic.view_count) + ' 浏览'))).toBeTruthy();
});

it('结果态（用户档）：昵称 + @handle；重名的标出「重名」', () => {
  const users: SearchUser[] = [
    { id: 'u_02', handle: 'demo-marine', nickname: '陆战队员', avatar: null, level: 5, ambiguous: true },
    { id: 'u_04', handle: 'demo-zealot', nickname: '狂热者', avatar: null, level: 8, ambiguous: false },
  ];
  render(<SearchPanel {...base} tab='users' state='ready' users={users} />);
  expect(screen.getByText('@demo-marine')).toBeTruthy();
  expect(screen.getByText('@demo-zealot')).toBeTruthy();
  expect(screen.getAllByText('重名')).toHaveLength(1);
});

it('切换两档走 onTabChange（不是页内自己藏一份状态）', () => {
  const onTabChange = vi.fn();
  render(<SearchPanel {...base} onTabChange={onTabChange} />);
  // Ring 的 TabLink 把标题渲染 4 份：1 份可见 + 3 份量宽副本（aria-hidden 在**父 span** 上，
  // 所以 getByText 的 ignore 过滤不掉 —— 实测 4 份都留在匹配里）。可见的那份固定排第一。
  act(() => screen.getAllByText('用户')[0]!.click());
  expect(onTabChange).toHaveBeenCalledWith('users');
});

it('搜索与清除是两个动作：回车/点击提交，清除只在有输入时出现', () => {
  const onSubmit = vi.fn();
  const { rerender } = render(<SearchPanel {...base} q='' onSubmit={onSubmit} />);
  expect(screen.queryByRole('button', { name: '清除搜索' })).toBeNull();
  act(() => screen.getByRole('button', { name: '搜索' }).click());
  expect(onSubmit).toHaveBeenCalledTimes(1);
  rerender(<SearchPanel {...base} q='战役' onSubmit={onSubmit} />);
  expect(screen.getByRole('button', { name: '清空搜索词' })).toBeTruthy();
});

it('错误态：说清是只读操作 + 给重试，不让人去刷新整页', () => {
  const onRetry = vi.fn();
  render(<SearchPanel {...base} state='error' onRetry={onRetry} />);
  expect(screen.getByText('搜索失败了')).toBeTruthy();
  act(() => screen.getByRole('button', { name: '重试' }).click());
  expect(onRetry).toHaveBeenCalledTimes(1);
});
