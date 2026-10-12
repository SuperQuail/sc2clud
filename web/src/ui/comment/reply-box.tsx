import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';

// 回复框。**复用 Ring UI 的 Input（multiline）与 Button**——不自己写 textarea 与按钮。
// 回复某人时在正文前显示 @昵称，取消时清空。
export function ReplyBox({
  replyingTo,
  placeholder = '说点什么…',
  onSubmit,
  onCancel,
}: {
  /** 正在回复谁（显示 @昵称）；不传就是顶层评论框 */
  replyingTo?: string | null;
  placeholder?: string;
  onSubmit?: (body: string) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const empty = body.trim().length === 0;

  function submit() {
    if (empty) {
      setError('还没写内容');
      return;
    }
    setError(null);
    onSubmit?.(body.trim());
    setBody('');
  }

  return (
    <div className='flex flex-col gap-2'>
      {replyingTo ? (
        <span className='text-[12px] text-muted-foreground'>回复 @{replyingTo}</span>
      ) : null}
      <Input
        multiline
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        error={error ?? undefined}
      />
      <div className='flex items-center gap-2'>
        <Button primary onClick={submit}>发布</Button>
        <Button ghost onClick={onCancel}>取消</Button>
        <span className='ml-auto text-[11px] text-muted-foreground'>支持 Markdown　⌘/Ctrl + Enter 发布</span>
      </div>
    </div>
  );
}
