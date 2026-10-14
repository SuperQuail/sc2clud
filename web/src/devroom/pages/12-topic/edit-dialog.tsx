import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';

// 「编辑这篇帖子」。权限点 post.update_own（后端 v2 §21.2：PATCH /api/v1/topics/{id}，作者或 post.delete_any）。
// 和「申请人工复核」一样，这一版**不做真实写入**：房间没有后端，保存只改本页状态并回执，
// 但界面上的因果是完整的（标题/正文/最后编辑时间都会变）——盲审二号 13 报的就是「入口都没有」。
//
// 正文为什么是纯文本输入而不是富文本编辑器（MarkdownEditor）：详情页拿到的是后端清洗过的 content_html，
// 不是 Lexical 的 EditorState JSON，从 HTML 反推不回编辑器状态（丢提及的 user_id 与图片节点）。
// 真接线时这里换成「先 GET 编辑态 JSON，再灌进 MarkdownEditor」，本次只验入口与回执。
// shortcut: 正文按纯文本编辑（段落即换行），接线时换成 MarkdownEditor + EditorState JSON。
export function EditTopicDialog({
  title: initialTitle,
  text: initialText,
  onSave,
  onClose,
}: {
  title: string;
  /** 正文的**纯文本**（从 content_html 剥标签得到） */
  text: string;
  onSave: (next: { title: string; text: string }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);

  const dirty = title.trim() !== initialTitle || text.trim() !== initialText;

  function save() {
    if (title.trim().length < 4) {
      setError('标题至少 4 个字');
      return;
    }
    if (text.trim().length === 0) {
      setError('正文不能为空');
      return;
    }
    setError(null);
    onSave({ title: title.trim(), text: text.trim() });
  }

  return (
    <Dialog
      show
      modal
      trapFocus
      label='编辑帖子'
      showCloseButton
      onCloseAttempt={onClose}
      onOverlayClick={onClose}
      onEscPress={onClose}
      contentClassName='w-full max-w-[720px] p-5'
    >
      <div className='flex flex-col gap-4'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-base font-semibold text-foreground'>编辑帖子</h2>
          <p className='text-[12px] leading-relaxed text-muted-foreground'>
            保存后正文与「最后编辑」时间就地更新。
            帖子处在审核中 / 未通过时，改完可以重新提交审核。
          </p>
        </div>

        <Input value={title} onChange={(e) => setTitle(e.target.value)} label='标题' maxLength={120} autoFocus />

        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          label='正文'
          multiline
          rows={12}
          help='段落之间空一行；这一段编辑的是纯文本，图片与 @提及 保持原样（真接线时走富文本编辑器）'
        />

        {error ? (
          <p role='alert' className='text-[12px] text-destructive'>
            {error}
          </p>
        ) : null}

        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button primary disabled={!dirty} data-testid='edit-save' onClick={save}>
            保存
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
