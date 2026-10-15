import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MailTemplateScreen, type MailTemplateScreenProps } from './mail-tpl';
import type { MailTemplate, MailTemplatePreview } from '@/lib/api/admin';

// D37 前端用例的判据都钉在**后果**上，不是「按钮在不在」：
//   · 转义证据 = srcdoc 属性里是 &lt;script&gt; 字面量，且 document 里没有任何脚本节点在 iframe 之外；
//   · 编辑框回显的是当前生效的那三段源（内置回显也算数据，不是空框）；
//   · 保存送的是编辑框里改过的三份源（PUT 全量），编译错误贴在对应文本域旁边。

const TPL: MailTemplate[] = [
  { kind: 'verify_email', custom: true, subject: '注册验证 {{.Code}}', html_body: '<p>自定义 {{.Code}}</p>', text_body: '自定义 {{.Code}}', updated_at: '2026-10-15T12:00:00Z', updated_by: 1 },
  { kind: 'reset_password', custom: false, subject: '重置密码验证码', html_body: '<p>你正在重置密码，验证码是：</p>', text_body: '你正在重置密码…', updated_at: null, updated_by: null },
  { kind: 'test', custom: false, subject: '发信测试', html_body: '<p>发信测试</p>', text_body: '发信测试', updated_at: null, updated_by: null },
  { kind: 'notice', custom: true, subject: '站内通知 {{.Title}}', html_body: '<p>{{.Body}}</p>', text_body: '{{.Body}}', updated_at: '2026-10-14T09:00:00Z', updated_by: 2 },
];

const PREVIEW: MailTemplatePreview = {
  subject: '重置你的密码 123456',
  text: '你好：\n\n爱<>(如:<script>alert(1)</script>，你在重置密码，验证码是：123456\n\n-- 测试站',
  html: '<!DOCTYPE html><html><head><title>r3</title></head><body>'
    + '<p>自定义正文 123456，<b>爱&(如:&lt;script&gt;alert(1)&lt;/script&gt;</b></p>'
    + '<p>这封邮件由 测试站 系统自动发出</p></body></html>',
};

function props(over: Partial<MailTemplateScreenProps> = {}): MailTemplateScreenProps {
  return Object.assign(
    {
      templates: TPL,
      canManage: true,
      onSave: vi.fn(),
      onReset: vi.fn(),
      onPreview: vi.fn(),
      preview: null,
    } satisfies MailTemplateScreenProps,
    over,
  );
}

it('转义证据：样本昵称的 <script> 在 srcdoc 里是被转义的字面量，且不在 iframe 之外有任何脚本节点', () => {
  render(<MailTemplateScreen {...props({ preview: PREVIEW })} />);
  const frame = screen.getByTitle('邮件预览（沙盒）');
  expect(frame.tagName).toBe('IFRAME');
  // 沙盒：不给任何权限（脚本、同源、表单全关）
  expect(frame.getAttribute('sandbox')).toBe('');
  const srcdoc = frame.getAttribute('srcdoc') ?? '';
  expect(srcdoc).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(srcdoc).not.toContain('<script>alert(1)');
  // 纯文本并列：pre 里的原文是**文本节点**（不是 HTML）
  const pre = screen.getByTestId('mail-tpl-text');
  expect(pre.textContent).toContain('<script>alert(1)</script>');
  // 主文档里不允许出现任何 script 节点 —— 预览的唯一通道是那个 iframe
  expect(document.querySelectorAll('script')).toHaveLength(0);
});

it('四行列表带内置/自定义标记；编辑框回显当前生效的三段源', () => {
  render(<MailTemplateScreen {...props()} />);
  for (const kind of ['verify_email', 'reset_password', 'test', 'notice']) {
    expect(screen.getByTestId('mail-tpl-kind-' + kind)).toBeTruthy();
  }
  expect(screen.getAllByText('自定义')).toHaveLength(2);
  expect(screen.getAllByText('内置')).toHaveLength(2);
  fireEvent.click(screen.getByTestId('mail-tpl-kind-notice'));
  expect((screen.getByLabelText(/主题/) as HTMLInputElement).value).toBe('站内通知 {{.Title}}');
  expect((screen.getByLabelText(/HTML 正文/) as HTMLTextAreaElement).value).toBe('<p>{{.Body}}</p>');
});

it('保存送的是编辑框里改过的三份源（PUT 全量），没改就置灰', () => {
  const onSave = vi.fn();
  render(<MailTemplateScreen {...props({ onSave })} />);
  const save = screen.getByTestId('mail-tpl-save') as HTMLButtonElement;
  expect(save.disabled).toBe(true); // 初始与现状一致：不该可保存
  fireEvent.change(screen.getByLabelText(/主题/), { target: { value: '新主题 {{.Code}}' } });
  fireEvent.click(screen.getByTestId('mail-tpl-save'));
  expect(onSave).toHaveBeenCalledWith('verify_email', {
    subject: '新主题 {{.Code}}',
    html_body: '<p>自定义 {{.Code}}</p>',
    text_body: '自定义 {{.Code}}',
  });
});

it('预览送的是编辑框里还没保存的那份（kind + 三段可选）', () => {
  const onPreview = vi.fn();
  render(<MailTemplateScreen {...props({ onPreview })} />);
  fireEvent.click(screen.getByTestId('mail-tpl-preview'));
  expect(onPreview).toHaveBeenCalledWith('verify_email', {
    subject: '注册验证 {{.Code}}',
    html_body: '<p>自定义 {{.Code}}</p>',
    text_body: '自定义 {{.Code}}',
  });
});

it('编译错误原话就地贴在对应文本域旁（带行位）', () => {
  const fields = { html_body: 'template: notice:html:2: unexpected end of action' };
  render(<MailTemplateScreen {...props({ fields })} />);
  fireEvent.click(screen.getByTestId('mail-tpl-kind-notice'));
  expect(screen.getByTestId('mail-tpl-err-html_body').textContent).toContain('notice:html:2');
});

it('「恢复内置」要过确认弹层；取消不动，确认才 onReset', () => {
  const onReset = vi.fn();
  render(<MailTemplateScreen {...props({ onReset })} />);
  fireEvent.click(screen.getByTestId('mail-tpl-reset'));
  // Ring Dialog 的标题不落 jsdom（走 portal），所以断言的是对话框正文
  expect(screen.getByText(/下一次渲染立即落回系统内置模板/)).toBeTruthy();
  fireEvent.click(screen.getByText('取消'));
  expect(onReset).not.toHaveBeenCalled();
  expect(screen.queryByText(/下一次渲染立即落回系统内置模板/)).toBeNull();
  fireEvent.click(screen.getByTestId('mail-tpl-reset'));
  fireEvent.click(document.querySelector('button.ring-button-danger') as HTMLButtonElement);
  expect(onReset).toHaveBeenCalledWith('verify_email');
});
