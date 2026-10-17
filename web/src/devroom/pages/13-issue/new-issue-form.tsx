import Input from '@jetbrains/ring-ui-built/components/input/input';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';

// 表单里的「标题 + 正文」两格。**单拆一个文件是为了按需加载**：MarkdownEditor 会把 Lexical 整包
// （约 100KB gzip）拖进首屏，而反馈页的列表、检索条、详情都不该为它付这个钱。
// 与 12-topic 的举报/编辑两个弹层同一个做法（见 topic-view.tsx 顶部的 lazy）。
export function NewIssueFormEditor({
  title,
  onTitle,
  onBody,
  onLength,
}: {
  title: string;
  onTitle: (v: string) => void;
  onBody: (json: string, html: string) => void;
  onLength: (n: number) => void;
}) {
  return (
    <div className='flex flex-col gap-4'>
      <Input
        value={title}
        onChange={(e) => onTitle(e.target.value)}
        label='标题'
        placeholder='例：第三章隐藏结局在 15:00 前抵达也不触发'
        maxLength={120}
        autoFocus
      />
      <div className='flex flex-col gap-1.5'>
        <span className='text-[12px] font-medium text-foreground'>正文</span>
        <MarkdownEditor value='' onChange={onBody} onLengthChange={onLength} maxLength={20000} />
      </div>
    </div>
  );
}
