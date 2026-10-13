import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import {
  LexicalTypeaheadMenuPlugin,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { ELEMENT_TRANSFORMERS, TEXT_FORMAT_TRANSFORMERS, TEXT_MATCH_TRANSFORMERS } from '@lexical/markdown';
import { $generateHtmlFromNodes } from '@lexical/html';
import { $createQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text';
import { INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode } from '@lexical/list';
import { LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $createTextNode, $getRoot, $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type EditorState, type LexicalEditor, type TextNode } from 'lexical';
// $setBlocksType 在官方的 @lexical/selection 包里（不在核心包）
import { $setBlocksType } from '@lexical/selection';
import { Bold, Code, Italic, Link2, List, Quote, AtSign } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { MentionMenu } from '@/ui/comment/mention-menu';
import { MentionOption } from '@/ui/comment/mention-option';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { assetUrl } from '@/lib/url';
import { MaxLengthPlugin } from './lexical/max-length-plugin';
import { ImageUploader, type UploadedImage } from './image-uploader';
import { planImages, POST_IMAGE_MAX_BYTES, processImage } from './image-pipeline';
import { theme } from './lexical/theme';
import { $createMentionNode, MentionNode } from './lexical/mention-node';
import { $createImageNode, ImageNode, countImageNodes } from './lexical/image-node';

// 富文本编辑器（所见即所得）。**存储用 Lexical 自带的 EditorState JSON**——
// @提及用 **Lexical 官方 LexicalTypeaheadMenuPlugin**：贴合触发文字的定位、滚动跟随、
// ↑↓/Enter/Esc、查询词清空即关闭——全是库自带能力，不自己算光标坐标（手搓那版会飘）。
// 这是库的原生格式：节点自带 type/version，exportJSON/importJSON 无损往返，不依赖我们自己写的转换器。
// Markdown 只留「打字快捷方式」（**粗体**、> 引用…），**不再是存储格式**：
// Lexical 的原生存储是 EditorState JSON（每个节点自带 type/version，exportJSON/importJSON 无损往返）。
const SHORTCUT_TRANSFORMERS = [...ELEMENT_TRANSFORMERS, ...TEXT_FORMAT_TRANSFORMERS, ...TEXT_MATCH_TRANSFORMERS];

// 工具栏。**每个按钮都必须有对应的官方命令**（引用/列表原先接的是斜体/粗体的命令，点了没用）：
//   行内格式 → FORMAT_TEXT_COMMAND
//   无序列表 → INSERT_UNORDERED_LIST_COMMAND（@lexical/list）
//   引用     → 没有 INSERT 命令，用 $setBlocksType + $createQuoteNode（@lexical/rich-text）
function Toolbar({ onMention }: { onMention: () => void }) {
  const [editor] = useLexicalComposerContext();

  const inEditor = (fn: () => void) => () => {
    editor.focus();
    editor.update(fn);
  };

  // 纯图标按钮在 Ring 里默认走 inline（isInline = inline ?? text ?? !!icon）：display:inline + padding:0，
  // 于是 7 个图标的热区只有 16×16。这里显式 inline={false} + S 档 → 24×24 的透明底图标（ghost 保持无框观感）。
  return (
    <div className='flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-1'>
      <Button inline={false} height={ControlsHeight.S} data-testid='toolbar-bold' ghost icon={icon16(Bold)} aria-label='粗体' title='粗体' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')} />
      <Button inline={false} height={ControlsHeight.S} data-testid='toolbar-italic' ghost icon={icon16(Italic)} aria-label='斜体' title='斜体' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')} />
      <Button inline={false} height={ControlsHeight.S} data-testid='toolbar-code' ghost icon={icon16(Code)} aria-label='行内代码' title='行内代码' onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')} />
      <Button
        data-testid='toolbar-quote'
        inline={false}
        height={ControlsHeight.S}
        ghost
        icon={icon16(Quote)}
        aria-label='引用'
        title='引用'
        onClick={inEditor(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) $setBlocksType(sel, () => $createQuoteNode());
        })}
      />
      <Button
        data-testid='toolbar-list'
        inline={false}
        height={ControlsHeight.S}
        ghost
        icon={icon16(List)}
        aria-label='无序列表'
        title='无序列表'
        onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
      />
      <Button inline={false} height={ControlsHeight.S} data-testid='toolbar-link' ghost icon={icon16(Link2)} aria-label='链接' title='链接' onClick={() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://')} />
      <Button inline={false} height={ControlsHeight.S} ghost icon={icon16(AtSign)} aria-label='提及某人' title='提及某人' onClick={onMention} />
    </div>
  );
}

/** 首次挂载时把已存的内容灌进编辑器：value 是 `SerializedEditorState` 的 JSON 字符串。
 *  空串就保持空白；解析失败直接抛出（保存的是我们自己的格式，不该出现坏数据）。 */
function InitialState({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (!value) return;
    editor.setEditorState(editor.parseEditorState(value));
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
  maxLength = 20000,
  onLengthChange,
}: {
  value: string;
  /** json = SerializedEditorState；html = 只读展示用（已由调用方决定是否再清洗） */
  onChange: (json: string, html: string) => void;
  placeholder?: string;
  candidates?: MentionCandidate[];
  compact?: boolean;
  images?: UploadedImage[];
  onImagesChange?: (next: UploadedImage[]) => void;
  maxImages?: number;
  allowOriginal?: boolean;
  compress?: boolean;
  /** 字数上限（帖子 20000、评论 10000）；超出部分会被自动截掉 */
  maxLength?: number;
  /** 把当前字数报给使用方（发布按钮要用） */
  onLengthChange?: (length: number) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [docImages, setDocImages] = useState(0);
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

  // 同时给出**存储格式（JSON）**与**展示格式（HTML）**：
  //   JSON 是编辑真源（无损，含提及节点的 user_id）；HTML 给列表/搜索等只读场景用，服务端会再清洗一遍。
  /** 拖拽图片进来：**与点选上传走同一条管线**（压缩、限额都一样），插到正文里 */
  const onDropFiles = useCallback(
    async (files: File[]) => {
      const pics = files.filter((f) => f.type.startsWith('image/'));
      if (pics.length === 0) return;
      // 拖拽与点选共用同一个判定：过大的**当场丢掉且不占名额**（image-pipeline 里，2026-10-13 补体积上限）
      const { room, tooBig } = planImages({ existing: docImages, max: maxImages, compress, files: pics });
      const usable = tooBig ? pics.filter((f) => f.size <= POST_IMAGE_MAX_BYTES) : pics;
      if (room === 0 || usable.length === 0) return;
      const accepted: UploadedImage[] = [];
      for (const f of usable.slice(0, room)) {
        const blob = await processImage(f, { existing: docImages, max: maxImages, compress });
        accepted.push({
          id: Math.random().toString(36).slice(2),
          name: f.name,
          size: blob.size,
          url: URL.createObjectURL(blob),
          original: false,
          file: blob,
        });
      }
      onImagesChange?.([...(images ?? []), ...accepted]);
      insertImages(accepted);
    },
    [docImages, insertImages, maxImages, onImagesChange],
  );

  const onEditorChange = useCallback(
    (state: EditorState) => {
      const editor = editorRef.current;
      if (!editor) return;
      const tree = state.toJSON();
      const json = JSON.stringify(tree);
      const html = state.read(() => $generateHtmlFromNodes(editor, null));
      // 图片数从**文档**里数：在正文删掉图片，计数器就跟着降
      setDocImages(countImageNodes(tree));
      onLengthChange?.(editor.getRootElement()?.textContent?.length ?? 0);
      onChange(json, html);
    },
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
        {/* 拖拽落点：必须包住**有尺寸**的元素——之前挂在一个 0 高度的空 div 上，
            指针永远进不去，「拖图进正文」实际一直是坏的（子 agent 审计发现）。 */}
        <div
          onDragOver={(e) => {
            if (!onImagesChange) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (!onImagesChange) return;
            e.preventDefault();
            setDragging(false);
            void onDropFiles(Array.from(e.dataTransfer.files));
          }}
          className={dragging ? 'rounded-lg ring-[3px] ring-ring/40' : undefined}
        >
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
        </div>
        <HistoryPlugin />
        <MaxLengthPlugin maxLength={maxLength} />
        <MarkdownShortcutPlugin transformers={SHORTCUT_TRANSFORMERS} />
        {/* 列表与链接的命令要靠官方插件注册，否则发出去没人接（这就是「点了没反应」的原因） */}
        <ListPlugin />
        <LinkPlugin />
        <OnChangePlugin onChange={onEditorChange} />
        <InitialState value={value} />
        {/* 自查开关只在开发构建里生效：产品包里不许留能改变行为的调试入口 */}
        <DemoImage
          enabled={import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === 'image'}
          src={assetUrl('miyin-portrait-320.webp')}
        />
        <DemoMention
          enabled={import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === 'mention'}
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
          images={[]}
          existingCount={docImages}
          onChange={(added) => insertImages(added)}
          max={maxImages}
          allowOriginal={allowOriginal}
          compress={compress}
          showThumbnails={false}
        />
      ) : null}
    </div>
  );
}
