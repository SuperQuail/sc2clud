import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PayloadBlock } from './ai-payload';
import type { AiPayloadView } from '@/lib/api/admin';

// D33①③：审核屏那块「**真正发给模型的那一份**」的渲染判据。
//
// 这一块的全部价值在于**它是后端组装的那一份的投影**，所以用例钉三件事：
//   ① 两段文本真的画出来了，而且 system / user 分得开（旧行为：屏上根本没有这两段）；
//   ② 图片逐张给出下场 —— **没发的那张必须说出为什么**（旧行为：界面上只有一句
//      「图片仅以 Markdown 字面量出现」，管理员看不出到底发了几张、哪张没发）；
//   ③ 读不到字节那一档要转人工，界面必须把「不是判违规」说出来。
//
// 用例读的是**后端契约的字段名**（AiPayloadView），不是这一块的内部结构：
// 字段名漂了这里就红 —— 这正是本仓库反复栽的「两侧各写一份」。

function payload(over: Partial<AiPayloadView> = {}): AiPayloadView {
  return {
    source: 'probe', topic_id: 0, title: '', trigger: 'create', open_reports: 0,
    system: '你是中文社区的内容审核员。',
    user_prefix: '', user_title: '', user_body: '', user_text: '标题：连通性测试\n\n正文：这是一次连接测试。',
    has_image_markdown: false, image_attachment_count: 0,
    images: [], image_count: 0, image_skipped: 0, image_bytes: 0,
    image_limit: 4, image_max_bytes: 2097152, image_read_failed: false,
    model: 'deepseek-flash', max_output_tokens: 512, strict_mode: false,
    tool_name: 'submit_review', categories: ['spam', 'ad'],
    ...over,
  };
}

it('连通测试样例：system 与 user 两段全文都在，且说清它只组装不外呼', () => {
  render(<PayloadBlock payload={payload()} />);
  expect(screen.getByTestId('ai-payload-system').textContent).toBe('你是中文社区的内容审核员。');
  expect(screen.getByTestId('ai-payload-user').textContent).toContain('这是一次连接测试');
  expect(screen.getByTestId('ai-payload').textContent).toContain('deepseek-flash');
  expect(screen.getByTestId('ai-payload').textContent).toContain('submit_review');
  // 「不会真的外呼」必须写在脸上：这一块是 dry-run 的回执
  expect(screen.getByTestId('ai-payload').textContent).toContain('dry-run');
});

it('真帖子：标题/正文分段画（拼得回那一条 user），图片逐张给出下场与原因', () => {
  render(<PayloadBlock payload={payload({
    source: 'topic', topic_id: 42, title: '带图的帖子',
    user_prefix: '【举报复核】该帖已被 3 人举报，重点看是否违规。\n',
    user_title: '标题：带图的帖子', user_body: '正文：\n看图：\n\n![封面](/img/aaaa)', user_text: '',
    has_image_markdown: true, image_attachment_count: 2,
    images: [
      { position: 0, floor: 1, hash: 'a'.repeat(64), mime: 'image/webp', bytes: 120000, sent: true, note: '' },
      { position: 1, floor: 1, hash: 'b'.repeat(64), mime: 'image/webp', bytes: 9000000, sent: false, note: '超过单张上限 2.0 MB，没发给模型' },
    ],
    image_count: 1, image_skipped: 1, image_bytes: 120000,
  })} />);
  expect(screen.getByTestId('ai-payload-title').textContent).toBe('标题：带图的帖子');
  expect(screen.getByTestId('ai-payload-body').textContent).toContain('正文：');
  expect(screen.getByTestId('ai-payload-prefix').textContent).toContain('3 人举报');

  const rows = screen.getAllByTestId('ai-payload-image');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('会发给模型');
  expect(rows[1]?.textContent).toContain('不发给模型');
  // **不许静默丢**：没发的那张必须写清为什么
  expect(rows[1]?.textContent).toContain('超过单张上限');
  const head = screen.getByTestId('ai-payload').textContent ?? '';
  expect(head).toContain('这次判 1 张图');
  expect(head).toContain('没发 1 张');
  expect(head).toContain('上限 4 张');
});

it('没有配图的帖子：明说「模型只收到上面的文本」，不让人以为图片也过去了', () => {
  render(<PayloadBlock payload={payload({ source: 'topic', topic_id: 7, title: '纯文字帖', user_body: '正文：\n只有文字。' })} />);
  const t = screen.getByTestId('ai-payload').textContent ?? '';
  expect(t).toContain('没有配图');
  expect(t).toContain('这次判 0 张图');
});

it('有图读不到字节：就地说是「转人工」，不是判违规（这一档最容易被读成「内容有问题」）', () => {
  render(<PayloadBlock payload={payload({ source: 'topic', topic_id: 9, image_read_failed: true })} />);
  const alert = screen.getByTestId('ai-payload-read-failed');
  expect(alert.textContent).toContain('转人工');
  expect(alert.textContent).toContain('不是');
});
