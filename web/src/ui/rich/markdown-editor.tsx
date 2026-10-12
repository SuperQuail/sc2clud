import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  ELEMENT_TRANSFORMERS,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
} from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { $createLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $createTextNode, $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type EditorState, type LexicalEditor } from 'lexical';
import { Bold, Code, Italic, Link2, List, Quote, AtSign } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { MentionSuggest } from '@/ui/comment/mention-suggest';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { ImageUploader, type UploadedImage } from './image-uploader';
import { theme } from './lexical/theme';

// 富文本编辑器（**所见即所得**）。内核用 Lexical：
//   · 编辑区里显示的就是渲染后的内容（不再左边原文右边预览）；
//   · Markdown 仍是底层——进出各一次转换（$convertFrom/ToMarkdownString），存的是 Markdown；
//   · @提及用 **`[@昵称](mention:<user_id>)`** 这种标准链接表示：
//     它是合法 Markdown、我们的渲染器已经认 `mention:` 协议，所以既能在编辑区显示成芯片，又能原样存下来。
//   · 工具栏与输入 @ 都走同一套候选面板（之前只有输入才会弹，按钮点了没用）。
const TRANSFORMERS = [...ELEMENT_TRANSFORMERS, ...TEXT_FORMAT_TRANSFORMERS, ...TEXT_MATCH_TRANSFORMERS];
const MENTION_PREFIX = 'mention:';

function Toolbar({ onMention }: { onMention: () => void }) {
  const [editor] = useLexicalComposerContext();
  return (
    <div className='flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-1'>
      <Button ghost icon={icon16(Bold)} aria-label='粗体' title='粗体' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')} />
      <Button ghost icon={icon16(Italic)} aria-label='斜体' title='斜体' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')} />
      <Button ghost icon={icon16(Code)} aria-label='行内代码' title='行内代码' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')} />
      <Button ghost icon={icon16(Quote)} aria-label='引用' title='引用' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')} />
      <Button ghost icon={icon16(List)} aria-label='列表' title='列表' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')} />
      <Button ghost icon={icon16(Link2)} aria-label='链接' title='链接' onClick={() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://')} />
      <Button ghost icon={icon16(AtSign)} aria-label='提及某人' title='提及某人' onClick={onMention} />
    </div>
  );
}

/** 初次挂载时把外部 value（Markdown）灌进编辑器；之后只在外部强制替换时同步 */
function InitialMarkdown({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (!value) return;
    editor.update(() => {
      $convertFromMarkdownString(value, TRANSFORMERS);
    });
  }, [editor, value]);
  return null;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder = '写点正文… Markdown 快捷输入：**粗体**、> 引用、- 列表、`代码`',
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
  compact?: boolean;
  images?: UploadedImage[];
  onImagesChange?: (next: UploadedImage[]) => void;
  maxImages?: number;
  allowOriginal?: boolean;
  compress?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const editorRef = useRef<LexicalEditor | null>(null);
  const matched = candidates.filter(
    (c) => c.nickname.toLowerCase().includes(query.toLowerCase()) || c.handle.toLowerCase().includes(query.toLowerCase()),
  );

  /** 把提及插到光标处：插入一个指向 `mention:<id>` 的链接，显示成 @昵称 */
  const insertMention = useCallback(
    (c: MentionCandidate) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        // 直接构造链接节点：指向 mention:<id>，显示成 @昵称。
        // （不去操作 selection 内部结构——那样很脆，且不同 Lexical 版本点对象 API 不一样。）
        const link = $createLinkNode(MENTION_PREFIX + c.id);
        link.append($createTextNode('@' + c.nickname));
        sel.insertNodes([link, $createTextNode(' ')]);
      });
      setMenuOpen(false);
      setQuery('');
      setActive(0);
    },
    [],
  );

  const onEditorChange = useCallback(
    (state: EditorState) => {
      state.read(() => onChange($convertToMarkdownString(TRANSFORMERS)));
    },
    [onChange],
  );

  return (
    <div className='flex flex-col gap-2'>
      <LexicalComposer
        initialConfig={{
          namespace: 'sc2clud-editor',
          theme,
          nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode],
          onError: (e) => {
            throw e;
          },
        }}
      >
        <Toolbar onMention={() => setMenuOpen(true)} />
        <div className='relative'>
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-label='正文'
                data-placeholder={placeholder}
                className={
                  'rounded-lg border border-input bg-background px-3 py-2.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 ' +
                  (compact ? 'min-h-20' : 'min-h-64')
                }
              />
            }
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
          <OnChangePlugin onChange={onEditorChange} />
          <InitialMarkdown value={value} />
          <EditorRef editorRef={editorRef} onQuery={setQuery} onOpen={setMenuOpen} />
        </div>
      </LexicalComposer>
      {menuOpen ? (
        <MentionSuggest candidates={matched} activeIndex={active} onPick={insertMention} />
      ) : null}
      {onImagesChange ? (
        <ImageUploader
          images={images ?? []}
          onChange={(next) => {
            onImagesChange(next);
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

/** 暴露 editor 实例，并在输入 @ 时自动打开候选（与工具栏按钮走同一个面板） */
function EditorRef({
  editorRef,
  onQuery,
  onOpen,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
  onQuery: (q: string) => void;
  onOpen: (open: boolean) => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
        const before = sel.anchor.getNode().getTextContent().slice(0, sel.anchor.offset);
        const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
        if (m) {
          onQuery(m[1]!);
          onOpen(true);
        }
      });
    });
  }, [editor, editorRef, onOpen, onQuery]);
  return null;
}
