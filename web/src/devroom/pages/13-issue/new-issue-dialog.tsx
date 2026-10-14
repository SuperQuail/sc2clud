import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';
import { ISSUE_KIND_META } from '../12-topic/_task/types';
import { KINDS, IssueKindButton } from './shared';
import type { IssueKind } from './types';

// 「我要反馈」面板：Ring UI Dialog（遮罩点击 / Esc / 焦点陷阱都由控件负责）。
// 标题 + 正文（复用 @/ui/rich/markdown-editor）+ 类型（四个 IssueKindButton 之一）+ 提交。
export function NewIssueDialog({
  initialKind,
  onClose,
  onSubmit,
}: {
  initialKind: IssueKind;
  onClose: () => void;
  onSubmit: (draft: { kind: IssueKind; title: string; bodyHtml: string; bodyJson: string }) => void;
}) {
  const [kind, setKind] = useState<IssueKind>(initialKind);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState({ json: '', html: '' });
  const [length, setLength] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (title.trim().length < 4) {
      setError('标题至少 4 个字，写清楚「在哪、什么现象」修复最快');
      return;
    }
    if (length === 0) {
      setError('正文还没写');
      return;
    }
    setError(null);
    onSubmit({ kind, title: title.trim(), bodyHtml: body.html, bodyJson: body.json });
  }

  return (
    <Dialog
      show
      modal
      trapFocus
      label='我要反馈'
      showCloseButton
      onCloseAttempt={onClose}
      contentClassName='w-full max-w-[760px] p-5'
    >
      <div className='flex flex-col gap-4'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-base font-semibold text-foreground'>我要反馈</h2>
          <p className='text-[12px] text-muted-foreground'>
            先选类型，再写标题与正文。提交后会存到服务端，并立刻出现在左边的列表里。
          </p>
        </div>

        <div className='flex flex-col gap-2'>
          <span className='text-[12px] font-medium text-foreground' id='new-issue-kind-label'>
            类型
          </span>
          <div role='group' aria-labelledby='new-issue-kind-label' className='flex flex-wrap items-center gap-2'>
            {KINDS.map((k) => (
              // 选中环画在容器上：共享件没有 className prop，也不该为这一处去改它的外观
              <span
                key={k}
                className={
                  'inline-flex rounded-md ' + (kind === k ? 'ring-[3px] ring-ring/60' : 'ring-1 ring-transparent')
                }
              >
                <IssueKindButton kind={k} onSelect={setKind} />
              </span>
            ))}
          </div>
          <span className='text-[11px] text-muted-foreground'>当前选择：{ISSUE_KIND_META[kind].label}</span>
        </div>

        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          label='标题'
          placeholder='例：第三章隐藏结局在 15:00 前抵达也不触发'
          maxLength={120}
          autoFocus
        />

        <div className='flex flex-col gap-1.5'>
          <span className='text-[12px] font-medium text-foreground'>正文</span>
          <MarkdownEditor value={body.json} onChange={(json, html) => setBody({ json, html })} onLengthChange={setLength} maxLength={20000} />
        </div>

        {error ? (
          <p role='alert' className='text-[12px] text-destructive'>
            {error}
          </p>
        ) : null}

        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button primary onClick={submit}>
            提交反馈
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
