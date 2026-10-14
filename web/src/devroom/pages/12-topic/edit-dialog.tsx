import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';
import type { MentionCandidate } from '@/ui/comment/mention-types';

// 「编辑这篇帖子」。权限点 post.update_own（后端 v2 §21.2：PATCH /api/v1/topics/{id}，作者或 post.delete_any）。
//
// 正文是**同一个 MarkdownEditor**（拍板 08 §第三轮 5）：编辑与发帖必须是同一份实现 ——
// 两个入口对同一段正文给出不同的能力（这里能插图/提及、那里不能）是上一版的缺陷，
// 而它当时是被一句「真接线时再换」的注释盖住的。
//
// 为什么初值必须是 `content_md`（Lexical EditorState 的 JSON）而不是 content_html：
// 从清洗过的 HTML 反推不回编辑器状态（提及的 userId 与图片节点都会丢），
// 所以详情响应带着的那一列就是编辑的唯一真源 —— 灌进去、改完再原样发回去（PATCH 的 content_md）。
export function EditTopicDialog({
  title: initialTitle,
  contentMd,
  onSave,
  onClose,
  candidates = [],
  onMentionQuery,
}: {
  title: string;
  /** 正文真源：`TopicDetailDTO.content_md`（SerializedEditorState 的 JSON 字符串） */
  contentMd: string;
  onSave: (next: { title: string; json: string; html: string }) => void;
  onClose: () => void;
  /** @ 提及候选（与发帖页同一份来源；宿主拿不到就给空数组，编辑器自己会画空菜单） */
  candidates?: MentionCandidate[];
  /** 提及时已经打出来的那串字：向上报给宿主，由它去打候选端点 */
  onMentionQuery?: (q: string) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [doc, setDoc] = useState({ json: toEditorState(contentMd), html: '' });
  const [error, setError] = useState<string | null>(null);

  // 正文有没有东西看的是**编辑器给出的 HTML**：空编辑器的 HTML 是 '<p><br></p>'，
  // 只看 JSON 长度会把「什么都没写」当成有内容（与 18-compose 的 disabledReason 同一个判据；
  // 那边是页面自己的草稿规则，这一处只有「有没有字」一件事，所以不跨页 import 那一份）。
  const visible = (html: string) => html.replace(/<[^>]*>/g, '').trim().length;
  const bodyLen = visible(doc.html);
  // 脏判据不比较 JSON 字符串：EditorState 里带选区，同样一段字两次序列化就可能不同，
  // 拿它判「有没有改过」会让保存按钮在没动过时也是亮的（一个永远为真的检查）。
  const dirty = title.trim() !== initialTitle || bodyLen > 0;

  function save() {
    if (title.trim().length < 4) {
      setError('标题至少 4 个字');
      return;
    }
    if (visible(doc.html) === 0) {
      setError('正文不能为空');
      return;
    }
    setError(null);
    onSave({ title: title.trim(), json: doc.json, html: doc.html });
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

        <MarkdownEditor
          value={doc.json}
          onChange={(json, html) => setDoc({ json, html })}
          candidates={candidates}
          onQueryChange={onMentionQuery}
          placeholder='修改正文… 支持 **粗体**、> 引用、- 列表、@提及 与正文插图'
          maxLength={20000}
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
/** 把详情里的 content_md 变成 MarkdownEditor 能吃的 EditorState JSON。
 *
 *  **为什么需要这一层**：\`MarkdownEditor\` 的 InitialState 对坏 JSON 是**直接抛**的
 *  （它的注释写着「保存的是我们自己的格式，不该出现坏数据」），而后端 content_md 这一列
 *  还有**不是 JSON 的历史值** —— 老站存的是 Markdown 正文，迁移过来是纯文本，
 *  真站上一次编辑就会抛在用户脸上（测试里那条 \`SyntaxError: Unexpected token '正'\` 就是它）。
 *  规则只有两条：本来就是 EditorState 就原样用；否则把整段文本**保住**、包成一个最小文档。
 *  shortcut: 纯文本按段落折行（行内格式认不出来，能认的是真源那份 JSON）——
 *    等历史值都编辑过一遍之后，这一支可以直接删。
 */
export function toEditorState(value: string): string {
  if (value.trim() === '') return '';
  try {
    const parsed = JSON.parse(value) as { root?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.root) return value;
  } catch {
    // 不是 JSON：往下走，当成纯文本处理
  }
  return JSON.stringify({ root: { children: paragraphs(value), direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } });
}

function paragraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter((p) => p !== '')
    .map((p) => ({
      children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: p, type: 'text', version: 1 }],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'paragraph',
      version: 1,
    }));
}
