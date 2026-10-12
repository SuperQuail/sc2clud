import { useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size as InputSize } from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Bold, Code, Italic, Link2, List, Quote, AtSign } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { MentionSuggest } from '@/ui/comment/mention-suggest';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { ImageUploader, type UploadedImage } from './image-uploader';
import { markdownToHtml } from './markdown';

// 富文本（Markdown）编辑器 —— 一个控件，两种规模：
//   帖子正文：toolbar + 左右分栏（源码 / 实时预览）+ 图片上传；
//   评论：同样的东西，关掉图片、预览收成一栏（compact）。
// 底层是 **Markdown 文本**（后端 content_md 就是它），HTML 只由 marked+DOMPurify 现算现用。
const TOOLS: Array<{ key: string; label: string; Icon: typeof Bold; wrap: [string, string] }> = [
  { key: 'bold', label: '粗体', Icon: Bold, wrap: ['**', '**'] },
  { key: 'italic', label: '斜体', Icon: Italic, wrap: ['*', '*'] },
  { key: 'quote', label: '引用', Icon: Quote, wrap: ['> ', ''] },
  { key: 'list', label: '列表', Icon: List, wrap: ['- ', ''] },
  { key: 'code', label: '代码', Icon: Code, wrap: ['`', '`'] },
  { key: 'link', label: '链接', Icon: Link2, wrap: ['[', '](https://)'] },
];

export function MarkdownEditor({
  value,
  onChange,
  placeholder = '写点正文… Markdown：**粗体**、> 引用、- 列表、`代码`',
  candidates = [],
  compact = false,
  images,
  onImagesChange,
  maxImages = 10,
  allowOriginal = false,
  compress = true,
}: {
  value: string;
  onChange: (md: string) => void;
  placeholder?: string;
  candidates?: MentionCandidate[];
  /** 评论用：单栏 + 预览可切、不带图片 */
  compact?: boolean;
  images?: UploadedImage[];
  onImagesChange?: (next: UploadedImage[]) => void;
  maxImages?: number;
  allowOriginal?: boolean;
  compress?: boolean;
}) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [showPreview, setShowPreview] = useState(!compact);
  const matched =
    query === null
      ? []
      : candidates.filter(
          (c) =>
            c.nickname.toLowerCase().includes(query.toLowerCase()) ||
            c.handle.toLowerCase().includes(query.toLowerCase()),
        );

  function surround(before: string, after: string) {
    const el = area.current;
    if (!el) return;
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? s;
    const next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, e + before.length);
    });
  }

  function readQuery(v: string, caret: number): string | null {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    return m ? m[1]! : null;
  }

  function insertMention(c: MentionCandidate) {
    const el = area.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]*)$/, '');
    const token = '@{' + c.id + '|' + c.nickname + '} ';
    onChange(before + token + value.slice(caret));
    setQuery(null);
    requestAnimationFrame(() => el?.focus());
  }

  const editor = (
    <div className='relative flex min-w-0 flex-col gap-2'>
      <Input
        multiline
        autogrow
        size={InputSize.FULL}
        height={ControlsHeight.L}
        value={value}
        inputRef={area}
        placeholder={placeholder}
        inputClassName={compact ? 'min-h-20 w-full resize-y leading-relaxed font-mono text-[13px]' : 'min-h-64 w-full resize-y leading-relaxed font-mono text-[13px]'}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(readQuery(e.target.value, e.target.selectionStart ?? e.target.value.length));
          setActive(0);
        }}
        onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
          if (query === null) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, Math.max(matched.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && matched[active]) {
            e.preventDefault();
            insertMention(matched[active]!);
          } else if (e.key === 'Escape') {
            setQuery(null);
          }
        }}
      />
      {query !== null ? <MentionSuggest candidates={matched} activeIndex={active} onPick={insertMention} /> : null}
    </div>
  );

  const preview = (
    <div
      className='prose prose-sm max-w-none min-w-0 overflow-auto rounded-lg border border-border bg-background px-3 py-2.5 text-foreground'
      // eslint-disable-next-line react/no-danger -- 已经过 DOMPurify 清洗（见 markdown.ts）
      dangerouslySetInnerHTML={{ __html: markdownToHtml(value || '*（预览）*') }}
    />
  );

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-1'>
        {TOOLS.map(({ key, label, Icon, wrap }) => (
          <Button key={key} ghost icon={icon16(Icon)} aria-label={label} title={label} onClick={() => surround(wrap[0], wrap[1])} />
        ))}
        {candidates.length > 0 ? (
          <Button ghost icon={icon16(AtSign)} aria-label='提及' title='提及' onClick={() => onChange(value + '@')} />
        ) : null}
        {compact ? (
          <Button ghost className='ml-auto' active={showPreview} onClick={() => setShowPreview((v) => !v)}>
            预览
          </Button>
        ) : null}
      </div>
      {compact ? (
        showPreview ? preview : editor
      ) : (
        <div className='grid min-w-0 gap-3 lg:grid-cols-2'>
          {editor}
          {preview}
        </div>
      )}
      {onImagesChange ? (
        <ImageUploader
          images={images ?? []}
          onChange={(next) => {
            onImagesChange(next);
            // 图片以 Markdown 形式写进正文（真实上传后换成 /img/<hash>）
            const added = next.filter((n) => !(images ?? []).some((o) => o.id === n.id));
            if (added.length > 0) onChange(value + added.map((a) => '\n![' + a.name + '](' + a.url + ')\n').join(''));
          }}
          max={maxImages}
          allowOriginal={allowOriginal}
          compress={compress}
        />
      ) : null}
    </div>
  );
}
