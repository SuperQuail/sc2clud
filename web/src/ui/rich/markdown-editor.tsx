import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  LexicalTypeaheadMenuPlugin,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  ELEMENT_TRANSFORMERS,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
} from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $createTextNode, $getRoot, $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type EditorState, type LexicalEditor, type TextNode } from 'lexical';
import { Bold, Code, Italic, Link2, List, Quote, AtSign } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { MentionMenu } from '@/ui/comment/mention-menu';
import { MentionOption } from '@/ui/comment/mention-option';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { assetUrl } from '@/lib/url';
import { ImageUploader, type UploadedImage } from './image-uploader';
import { theme } from './lexical/theme';
import { $createMentionNode, MentionNode } from './lexical/mention-node';
import { MENTION_TRANSFORMER } from './lexical/mention-transformer';
import { $createImageNode, ImageNode } from './lexical/image-node';
import { IMAGE_TRANSFORMER } from './lexical/image-transformer';

// 富文本编辑器（所见即所得，Markdown 底层）。
// @提及用 **Lexical 官方 LexicalTypeaheadMenuPlugin**：贴合触发文字的定位、滚动跟随、
// ↑↓/Enter/Esc、查询词清空即关闭——全是库自带能力，不自己算光标坐标（手搓那版会飘）。
// 提及是 `[@昵称](mention:<user_id>)` 标准 Markdown 链接（契约见后端方案 §9）。
const TRANSFORMERS = [
  MENTION_TRANSFORMER,
  IMAGE_TRANSFORMER,
  ...ELEMENT_TRANSFORMERS,
  ...TEXT_FORMAT_TRANSFORMERS,
  ...TEXT_MATCH_TRANSFORMERS,
];

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

function InitialMarkdown({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (!value) return;
    editor.update(() => $convertFromMarkdownString(value, TRANSFORMERS));
  }, [editor, value]);
  return null;
}

/** 自查开关：?demo=image 往正文里插一张图（验证图片是正文的一部分） */
function DemoImage({ enabled, src }: { enabled: boolean; src: string }) {
  const [editor] = useLexicalComposerContext();
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || done.current) return;
    done.current = true;
    window.setTimeout(() => {
      editor.update(() => {
        $getRoot().selectEnd();
        const sel = $getSelection();
        if ($isRangeSelection(sel)) sel.insertNodes([$createImageNode(src, '示例图')]);
      });
    }, 400);
  }, [editor, enabled, src]);
  return null;
}

function EditorHandle({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

/** 自查开关：?demo=mention 自动敲一个 @（真实路径，不伪造面板） */
function DemoMention({ enabled }: { enabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || done.current) return;
    done.current = true;
    window.setTimeout(() => {
      editor.focus();
      editor.update(() => {
        $getRoot().selectEnd();
        const sel = $getSelection();
        if ($isRangeSelection(sel)) sel.insertText('@');
      });
    }, 400);
  }, [editor, enabled]);
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
  const [query, setQuery] = useState<string | null>(null);
  const editorRef = useRef<LexicalEditor | null>(null);

  const triggerFn = useBasicTypeaheadTriggerMatch('@', { minLength: 0 });
  const options = useMemo(
    () =>
      candidates
        .filter((c) => {
          if (query === null) return true;
          const q = query.toLowerCase();
          return c.nickname.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q);
        })
        .map((c) => new MentionOption(c)),
    [candidates, query],
  );

  /** 选中候选：切掉查询词，插入指向 mention:<id> 的链接 */
  const onSelectOption = useCallback(
    (option: MentionOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editorRef.current?.update(() => {
        const mention = $createMentionNode(option.candidate.nickname, option.candidate.id);
        if (nodeToReplace) {
          const text = nodeToReplace.getTextContent();
          nodeToReplace.setTextContent(text.slice(0, text.lastIndexOf('@')));
          nodeToReplace.insertAfter(mention);
          mention.insertAfter($createTextNode(' '));
          mention.selectEnd();
        }
      });
      closeMenu();
    },
    [],
  );

  /** 工具栏 @ 按钮：往光标处插一个 @，剩下的交给插件的触发匹配 */
  const insertTrigger = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.update(() => {
      let sel = $getSelection();
      if (!$isRangeSelection(sel)) {
        $getRoot().selectEnd();
        sel = $getSelection();
      }
      if ($isRangeSelection(sel)) sel.insertText('@');
    });
  }, []);

  /** 把上传好的图片作为**正文节点**插到光标处（不是往下追加一行 Markdown 文本） */
  const insertImages = useCallback((items: UploadedImage[]) => {
    const editor = editorRef.current;
    if (!editor || items.length === 0) return;
    editor.update(() => {
      let sel = $getSelection();
      if (!$isRangeSelection(sel)) {
        $getRoot().selectEnd();
        sel = $getSelection();
      }
      if (!$isRangeSelection(sel)) return;
      for (const im of items) {
        sel.insertNodes([$createImageNode(im.url, im.name), $createTextNode(' ')]);
      }
    });
  }, []);

  const onEditorChange = useCallback(
    (state: EditorState) => state.read(() => onChange($convertToMarkdownString(TRANSFORMERS))),
    [onChange],
  );

  const onReady = useCallback((e: LexicalEditor) => {
    editorRef.current = e;
  }, []);

  return (
    <div className='flex flex-col gap-2'>
      <LexicalComposer
        initialConfig={{
          namespace: 'sc2clud-editor',
          theme,
          nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, MentionNode, ImageNode],
          onError: (e) => {
            throw e;
          },
        }}
      >
        <EditorHandle onReady={onReady} />
        <Toolbar onMention={insertTrigger} />
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
        <DemoImage
          enabled={typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'image'}
          src={assetUrl('miyin-portrait-320.webp')}
        />
        <DemoMention
          enabled={typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'mention'}
        />
        <LexicalTypeaheadMenuPlugin<MentionOption>
          onQueryChange={setQuery}
          onSelectOption={onSelectOption}
          triggerFn={triggerFn}
          options={options}
          menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
            anchorRef.current
              ? createPortal(
                  <MentionMenu
                    options={options}
                    selectedIndex={selectedIndex}
                    selectOptionAndCleanUp={selectOptionAndCleanUp}
                    setHighlightedIndex={setHighlightedIndex}
                  />,
                  anchorRef.current,
                )
              : null
          }
        />
      </LexicalComposer>
      {onImagesChange ? (
        <ImageUploader
          images={images ?? []}
          onChange={(next) => {
            onImagesChange(next);
            const added = next.filter((n) => !(images ?? []).some((o) => o.id === n.id));
            insertImages(added);
          }}
          max={maxImages}
          allowOriginal={allowOriginal}
          compress={compress}
          showList={false}
        />
      ) : null}
    </div>
  );
}
