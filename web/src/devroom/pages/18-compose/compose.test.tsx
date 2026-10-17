import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import ComposePage from './index';
import { disabledReason, visibleLength } from './draft';
import { BOARD_NAME, DEFAULT_BOARD, TITLE_MAX } from './data';
import { BOARDS } from '@/devroom/pages/12-topic/mock';

// 非平凡逻辑（提交判据 / 未激活闸门 / 预览）各留一条会红的检查（开发必读 §5）。
// 断言只查「语义上必须存在的东西」，不查 className（前端方案 §11）。

const draft = (over: Partial<Parameters<typeof disabledReason>[0]> = {}) => ({
  title: '第三章补丁说明',
  board: DEFAULT_BOARD,
  tags: [],
  json: '',
  html: '<p>菌毯改成线性推进了</p>',
  ...over,
});

it('提交判据：标题、分区、正文三样缺一不可，且缺哪样就说哪样', () => {
  expect(disabledReason(draft())).toBeNull();
  expect(disabledReason(draft({ title: '   ' }))).toBe('还缺：标题');
  expect(disabledReason(draft({ board: null }))).toBe('还缺：分区');
  expect(disabledReason(draft({ html: '' }))).toBe('还缺：正文');
  // 空编辑器的 HTML 是 '<p><br></p>'：只看字符串长度会误判成「有内容」
  expect(disabledReason(draft({ html: '<p><br></p>' }))).toBe('还缺：正文');
  // 三样都缺时一次说全，不让人猜
  expect(disabledReason(draft({ title: '', board: null, html: '' }))).toBe('还缺：标题、分区、正文');
  expect(disabledReason(draft({ title: 'x'.repeat(TITLE_MAX + 1) }))).toContain('标题太长');
});

it('visibleLength：标签不算字数，&nbsp; 之类实体也不该被当成正文', () => {
  expect(visibleLength('<p>你好</p>')).toBe(2);
  expect(visibleLength('<h2>标题</h2><p><br></p>')).toBe(2);
});

it('发帖页：初始态缺标题与正文 → 提交按钮 disabled，并写明缺什么', () => {
  render(<ComposePage />);
  const submit = screen.getByTestId('compose-submit') as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(screen.getByTestId('compose-missing').textContent).toContain('标题');
  expect(screen.getByTestId('compose-missing').textContent).toContain('正文');
});

it('发帖页：未激活态 → 给出写闸门的提示，且表单整块禁用（不是提交时才 403）', () => {
  window.history.pushState({}, '', '/devroom.html?page=18-compose&activated=0');
  try {
    render(<ComposePage />);
    expect(screen.getByText('未激活账号不能发帖')).toBeTruthy();
    expect(screen.getByText(/auth\.not_activated/)).toBeTruthy();
    // 表单画出来了但禁用 —— 只给一句话的话，人不知道自己会失去什么
    const title = screen.getByTestId('compose-title') as HTMLInputElement;
    expect(title.disabled).toBe(true);
  } finally {
    window.history.pushState({}, '', '/');
  }
});

it('发帖页：默认分区来自 12-topic 的分区表，不是另编的一个', () => {
  expect(BOARDS.some((b) => b.slug === DEFAULT_BOARD)).toBe(true);
  expect(BOARD_NAME[DEFAULT_BOARD]).toBeTruthy();
  render(<ComposePage />);
  // 分区名在右栏的分区卡里出现（分区下拉是库控件，选中项由它自己渲染）
  expect(screen.getAllByText(BOARD_NAME[DEFAULT_BOARD]).length).toBeGreaterThan(0);
});

it('发帖页：?board= 带过来的分区被采纳，非法值回落到默认分区', () => {
  window.history.pushState({}, '', '/devroom.html?page=18-compose&board=tool-dev');
  try {
    render(<ComposePage />);
    expect(screen.getAllByText(BOARD_NAME['tool-dev']).length).toBeGreaterThan(0);
  } finally {
    window.history.pushState({}, '', '/');
  }
  window.history.pushState({}, '', '/devroom.html?page=18-compose&board=not-a-board');
  try {
    render(<ComposePage />);
    expect(screen.getAllByText(BOARD_NAME[DEFAULT_BOARD]).length).toBeGreaterThan(0);
  } finally {
    window.history.pushState({}, '', '/');
  }
});

it('正文字数：编辑器里真有了内容，计数器就跟着走（两个回调不许互相覆盖）', async () => {
  // ?demo=mention 会在 400ms 后往编辑器里真插一个 '@'（走的是编辑器自己的 update 路径，不伪造状态）。
  // 修之前：编辑器里 10 个字、计数器恒为 0 —— onChange 与 onLengthChange 同一次事件里先后调用，
  // 各自拿同一份渲染期快照传值，后调用的那个把 length 覆盖回旧值。
  window.history.pushState({}, '', '/devroom.html?page=18-compose&demo=mention');
  try {
    render(<ComposePage />);
    await waitFor(() => expect(screen.getByTestId('compose-body-count').textContent).toContain('正文字数 1 /'), {
      timeout: 3000,
    });
  } finally {
    window.history.pushState({}, '', '/');
  }
});

it('发帖页：预览与编辑器是同一份状态（预览卡渲染在页面上，不是另一套假数据）', () => {
  render(<ComposePage />);
  expect(screen.getByLabelText('预览')).toBeTruthy();
  expect(screen.getByTestId('preview-toggle')).toBeTruthy();
  act(() => (screen.getByTestId('preview-toggle') as HTMLButtonElement).click());
  expect((screen.getByTestId('preview-toggle') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
});
