import { useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ContentEditable from '@jetbrains/ring-ui-built/components/contenteditable/contenteditable';
import { Bold, Italic, List, Quote, Code } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { ImageUploader, type UploadedImage } from './image-uploader';

// 富文本编辑器（可复用，帖子正文用）。
//   · 工具栏：粗体/斜体/引用/列表/代码——用 Ring 的 Button 复用按钮样式；
//   · 正文容器用 Ring 的 ContentEditable（库里唯一能内联渲染的容器）；
//   · 图片走 ImageUploader（数量上限、自动压缩、可选原图都由属性控制）。
// 命令用 document.execCommand：它已废弃但仍是被所有浏览器实现的唯一轻量方案；
// 引第三方编辑器（TipTap 等）要新增依赖，按项目约定不引——这是权衡后的选择，不是没想过。
const COMMANDS: Array<{ key: string; label: string; Icon: typeof Bold; cmd: string }> = [
  { key: 'bold', label: '粗体', Icon: Bold, cmd: 'bold' },
  { key: 'italic', label: '斜体', Icon: Italic, cmd: 'italic' },
  { key: 'quote', label: '引用', Icon: Quote, cmd: 'formatBlock:blockquote' },
  { key: 'list', label: '列表', Icon: List, cmd: 'insertUnorderedList' },
  { key: 'code', label: '代码', Icon: Code, cmd: 'formatBlock:pre' },
];

export function RichTextEditor({
  maxImages = 10,
  allowOriginal = false,
  compress = true,
  placeholder = '写点正文…支持粗体、引用、列表与代码块',
  onChange,
}: {
  maxImages?: number;
  /** 是否允许上传原图（false 时界面不出现该开关） */
  allowOriginal?: boolean;
  compress?: boolean;
  placeholder?: string;
  onChange?: (payload: { html: string; images: UploadedImage[] }) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [images, setImages] = useState<UploadedImage[]>([]);

  function run(cmd: string) {
    const [name, arg] = cmd.split(':');
    document.execCommand(name!, false, arg);
    host.current?.focus();
    emit();
  }

  function emit(next = images) {
    onChange?.({ html: host.current?.innerHTML ?? '', images: next });
  }

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-1'>
        {COMMANDS.map(({ key, label, Icon, cmd }) => (
          <Button key={key} ghost icon={icon16(Icon)} aria-label={label} title={label} onClick={() => run(cmd)} />
        ))}
      </div>
      <ContentEditable
        inputRef={host}
        aria-label='正文'
        data-placeholder={placeholder}
        className='min-h-40 rounded-lg border border-input bg-background px-3 py-2.5 text-[15px] leading-relaxed text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40'
        onInput={() => emit()}
      />
      <ImageUploader
        images={images}
        max={maxImages}
        compress={compress}
        allowOriginal={allowOriginal}
        onChange={(next) => {
          setImages(next);
          emit(next);
        }}
      />
    </div>
  );
}
