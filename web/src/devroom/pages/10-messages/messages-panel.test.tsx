import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { MessagesPanel, plainText } from './messages-panel';

// L8 的第二半：「发送图片」那颗按钮**不再装作能用**（后端没有通用图片通道 + body 是纯文本）。
// 上半（Unicode 表情不被正文链路破坏）在 messages-panel.test.ts 里，两半都是 L8。
// 为什么不直接删掉那颗按钮：设计稿里有它，删掉会让「以后接通道」这件事从界面上消失；
// 正确的形态是**看得见、按不动、说清原因**（与 G5 的 WIP 标记同一条规矩）。
it('「发送图片」是禁用 + 带原因，不再是一颗点了没反应的假按钮', () => {
  const onSend = vi.fn();
  render(
    <Providers>
      <MessagesPanel
        conversations={[{ peer: { handle: 'demo-admin', nickname: '示范管理员', avatar: null }, messages: [], summary: '', lastAt: '', unread: 0 }]}
        selectedHandle='demo-admin'
        messages={[]}
        onSelect={vi.fn()}
        onSend={onSend}
        onOpenPicker={vi.fn()}
      />
    </Providers>,
  );
  const attach = document.querySelector('[aria-label="发送图片"]') as HTMLButtonElement | null;
  expect(attach).toBeTruthy();
  expect(attach!.disabled).toBe(true);
  // 原因要写在 title 上（鼠标悬停与读屏都拿得到），不是只把按钮置灰
  expect(attach!.title).toContain('后端还没有');
  fireEvent.click(attach!);
  expect(onSend).not.toHaveBeenCalled();
  // 表情**不做按钮**（拍板）：直接粘 Unicode 就行
  expect(document.querySelector('[aria-label="表情"]')).toBeNull();
  // 正文链路仍然正常（这一条是防空壳：面板本身没被我的改动弄坏）
  expect(plainText('<p>🫡</p>')).toBe('🫡');
});
