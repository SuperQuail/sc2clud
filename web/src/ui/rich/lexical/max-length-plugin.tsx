import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $getSelection, $isRangeSelection, TextNode } from 'lexical';

// 字数上限。**Lexical 没有官方的 maxLength**，这是社区标准做法：用 registerNodeTransform
// 监听文本节点，超出就把该节点多出来的部分砍掉。不引第三方包——为 20 行代码加依赖不值得。
export function MaxLengthPlugin({ maxLength }: { maxLength: number }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (node) => {
      const size = $getRoot().getTextContentSize();
      if (size <= maxLength) return;
      const over = size - maxLength;
      const text = node.getTextContent();
      const keep = Math.max(0, text.length - over);
      if (keep === text.length) return;
      node.setTextContent(text.slice(0, keep));
      // 截断后把光标收到末尾，避免选区指向已删除的位置
      const sel = $getSelection();
      if ($isRangeSelection(sel)) node.selectEnd();
    });
  }, [editor, maxLength]);
  return null;
}
