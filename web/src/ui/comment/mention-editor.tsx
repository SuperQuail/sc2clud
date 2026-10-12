import { useEffect, useRef, useState } from 'react';
import ContentEditable from '@jetbrains/ring-ui-built/components/contenteditable/contenteditable';
import { MentionSuggest } from './mention-suggest';
import { htmlToStorage, storageToHtml } from './mention-format';
import type { MentionCandidate } from './mention-types';

// 带 @提及 的编辑器。**用 Ring UI 的 ContentEditable 承载**（它是库里唯一能内联渲染的容器），
// 而不是 textarea——textarea 只能显示原文，用户会看到 `@{123|唐天}` 这种内部格式。
// 对外接口是 **存储格式**（`@{id|昵称}`），内部渲染成芯片，两头由 mention-format 转换。
export function MentionEditor({
  value,
  onChange,
  candidates = [],
  placeholder = '你渴望拥有力量吗？评论让力量更强大',
  className,
}: {
  value: string;
  onChange: (storage: string) => void;
  candidates?: MentionCandidate[];
  placeholder?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const matched =
    query === null
      ? []
      : candidates.filter(
          (c) =>
            c.nickname.toLowerCase().includes(query.toLowerCase()) ||
            c.handle.toLowerCase().includes(query.toLowerCase()),
        );

  // 外部 value 变化（例如提交后清空）时同步 DOM；编辑中不要回写，否则光标会跳
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const html = storageToHtml(value);
    if (htmlToStorage(el.innerHTML) !== value) el.innerHTML = html;
  }, [value]);

  function readQuery(): string | null {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!node) return null;
    const text = (node.textContent ?? '').slice(0, sel!.anchorOffset);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
    return m ? m[1]! : null;
  }

  function handleInput() {
    const el = host.current;
    if (!el) return;
    setQuery(readQuery());
    setActive(0);
  }

  function pick(c: MentionCandidate) {
    const el = host.current;
    if (!el) return;
    // 把光标前的 `@查询词` 换成芯片
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        const cut = text.slice(0, range.startOffset).replace(/@([^\s@]*)$/, '');
        node.textContent = cut;
        range.setStart(node, cut.length);
        range.collapse(true);
      }
    }
    const chip = document.createElement('span');
    chip.dataset.mention = c.id;
    chip.contentEditable = 'false';
    chip.className = 'mention-chip';
    chip.textContent = '@' + c.nickname;
    const sel2 = window.getSelection();
    if (sel2 && sel2.rangeCount > 0) {
      const range = sel2.getRangeAt(0);
      range.insertNode(chip);
      const space = document.createTextNode('\u00a0');
      range.setStartAfter(chip);
      range.insertNode(space);
      range.setStartAfter(space);
      range.collapse(true);
      sel2.removeAllRanges();
      sel2.addRange(range);
    }
    setQuery(null);
    setActive(0);
    onChange(htmlToStorage(el.innerHTML));
  }

  return (
    <div className='relative'>
      <ContentEditable
        inputRef={host}
        aria-label='评论内容'
        data-placeholder={placeholder}
        className={className}
        onInput={handleInput}
        onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
          if (query === null) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, Math.max(matched.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && matched[active]) {
            e.preventDefault();
            pick(matched[active]!);
          } else if (e.key === 'Escape') {
            setQuery(null);
          }
          onChange(htmlToStorage(host.current?.innerHTML ?? ''));
        }}
      />
      {query !== null ? <MentionSuggest candidates={matched} activeIndex={active} onPick={pick} /> : null}
    </div>
  );
}
