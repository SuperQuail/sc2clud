import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ReviewScreen, type ReviewFilter } from './review';
import type { ReviewQueueItem } from '@/lib/api/admin';

// L6 后台侧（收尾对照表 §8.1 第 2 条）：审核队列补 state=revision_requested 那一档（列表筛选 + 操作），
// 以及 06.2 的闭环那一档 draft（已发布、改动等着替换上线）。
//
// 为什么这两条必须钉在**动作**上而不是「按钮在不在」：
//   · 「打回修改」与「拒绝」在后端是两个动作（request_revision / reject），屏上画了按钮而
//     onReview 传的还是 'reject' 的话，作者收到的是「这篇不行」—— 与拍板 08 · L6 要的
//     「改改就能过」正好相反，而界面上看不出任何区别；
//   · draft 档的行是 review_state='approved'，用旧的判据（只有 pending 能判）会把它们全部禁掉
//     —— 那样「通过再替换」永远替换不了，发布过的帖子改完就僵在那里。

function item(over: Partial<ReviewQueueItem>): ReviewQueueItem {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    board: { slug: 'campaign', name: '战役讨论' },
    author: { handle: 'alice', nickname: '爱丽丝', avatar: '', avatar_small: '' },
    kind: 'discussion',
    title: '教程',
    excerpt: '摘要',
    body_md: '正文',
    body_truncated: false,
    review_state: 'pending',
    review_note: null,
    review_source: null,
    reviewer: null,
    reviewed_at: null,
    review_verdict: null,
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-14T10:00:00Z',
    ...over,
  };
}

function renderScreen(items: ReviewQueueItem[]) {
  const onReview = vi.fn();
  const onFilterChange = vi.fn();
  const filter: ReviewFilter = { state: 'pending', board: 'all', q: '' };
  render(
    <ReviewScreen
      items={items}
      hasMore={false}
      filter={filter}
      onFilterChange={onFilterChange}
      canReview
      onReview={onReview}
    />,
  );
  return { onReview, onFilterChange };
}

/** 行内动作的三个按钮（避开 tab 与表头里同名的那些）。 */
function rowAction(name: string): HTMLElement {
  // 行 = 文案里有标题、且里面有 role=cell 的那一条（表头那一行没有 cell）。
  const row = screen.getAllByRole('row').find(
    (r) => r.textContent?.includes('教程') && r.querySelector('[role="cell"]') !== null,
  );
  const scope = row ?? document.body;
  const hit = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!hit) throw new Error('行内没有这个按钮：' + name);
  return hit;
}

it('打回修改发的是 request_revision（不是 reject），而且理由必填', async () => {
  const { onReview } = renderScreen([item({})]);
  fireEvent.click(rowAction('打回修改'));
  // 二次确认弹层里那句「打回并通知作者修改」是这一档独有的确认文案
  const confirm = screen.getByText('打回并通知作者修改').closest('button') as HTMLButtonElement;
  expect(confirm.disabled).toBe(true); // 理由必填：后端也强制（不说改哪里等于让作者猜）
  fireEvent.change(screen.getByLabelText(/打回意见/), { target: { value: '第三节请补图' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(onReview).toHaveBeenCalledWith(
    expect.objectContaining({ id: '11111111-1111-1111-1111-111111111111' }),
    'request_revision',
    '第三节请补图',
  ));
});

it('draft 档（已发布 + 待替换改动）可以放行，按钮文案说清是替换', async () => {
  const { onReview } = renderScreen([item({ review_state: 'approved' })]);
  const go = rowAction('放行改动') as HTMLButtonElement;
  expect(go.disabled).toBe(false);
  fireEvent.click(go);
  fireEvent.click(screen.getByText('通过并发布').closest('button') as HTMLButtonElement);
  await waitFor(() => expect(onReview).toHaveBeenCalledWith(
    expect.objectContaining({ review_state: 'approved' }),
    'approve',
    '',
  ));
});

it('五个档位各自可切，revision_requested 与 draft 都有入口', () => {
  const { onFilterChange } = renderScreen([item({})]);
  // Ring 的 Tabs 用 data-test="ring-dumb-tabs"（不是 data-testid），且 tabs 里没有 role=tab——
  // 这就是为什么这条断言按文案找按钮，而不是按 role。
  const tabs = document.querySelector('[data-test="ring-dumb-tabs"]') as HTMLElement;
  const cases: [string, string][] = [
    ['待审', 'pending'],
    ['打回修改', 'revision_requested'],
    ['待替换改动', 'draft'],
    ['已拒绝', 'rejected'],
    ['全部未通过', 'all'],
  ];
  for (const [title, state] of cases) {
    const tab = [...tabs.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(title));
    if (!tab) throw new Error('没有这个档位：' + title);
    fireEvent.click(tab);
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ state }));
  }
});

// D25①：右栏的「就地预览」必须是**正文全文**，不是摘要 —— 审核要判的是整篇内容。
// 旧行为下这条断言必红：右栏当时只画 active.excerpt，正文再长也只看得到 200 字。
it('右栏预览给的是正文全文（不是摘要），图片以 Markdown 原文可见', () => {
  const long = '开头。' + '正文段落，很长。'.repeat(30) + '\n\n![封面](/img/0123456789abcdef)\n\n结尾。';
  renderScreen([item({ title: '带图的长帖', body_md: long })]);
  fireEvent.click(screen.getAllByRole('row').find((r) => r.textContent?.includes('带图的长帖'))!);
  const pre = screen.getByTestId('review-preview-body');
  expect(pre.textContent).toBe(long);
  expect(pre.textContent).toContain('![封面](/img/0123456789abcdef)');
  // 摘要仍在（列表行要梗概），但预览不靠它：这一行是列表里的摘要，不是右栏那块
  expect(screen.getAllByText('摘要').length).toBeGreaterThan(0);
});

it('正文被截断时说出来，不把半篇当全文', () => {
  renderScreen([item({ title: '超长帖', body_md: '很', body_truncated: true })]);
  fireEvent.click(screen.getAllByRole('row').find((r) => r.textContent?.includes('超长帖'))!);
  expect(screen.getByText(/已截断/)).toBeTruthy();
});

it('revision_requested 是独立的一档：行内状态说「打回修改」，三个动作都在', () => {
  renderScreen([item({ review_state: 'revision_requested' })]);
  const row = screen.getAllByRole('row').find((r) => r.textContent?.includes('教程'));
  expect(row?.textContent).toContain('打回修改');
  // 打回态的行**仍然可判**（作者改完就能放行，放行后状态回 approved、读者重新看得到），
  // 所以三个动作都在。按钮文案是「通过」而不是「放行改动」：文案的判据是行本身
  // （draft 那一档的行是 approved），而**打回态的行也可能带着一份草稿** —— 那条路走的是
  // 放行 + PromotePendingRevision，后端会把状态一起带回 approved（见 review_queue.go）。
  expect(rowAction('通过')).toBeTruthy();
  expect(rowAction('打回修改')).toBeTruthy();
  expect(rowAction('拒绝')).toBeTruthy();
});
