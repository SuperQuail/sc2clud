import type { TextMatchTransformer } from '@lexical/markdown';
import { $createImageNode, ImageNode } from './image-node';

// 图片的 Markdown 往返：`![说明](地址)`。存的就是这个（后端的 content_md），
// 读回来还是图片节点——否则一存一读就退化成一行文字。
const PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/;

export const IMAGE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) => (node instanceof ImageNode ? '![' + node.getAlt() + '](' + node.getSrc() + ')' : null),
  importRegExp: PATTERN,
  regExp: new RegExp(PATTERN.source + '$'),
  replace: (textNode, match) => {
    textNode.replace($createImageNode(match[2]!, match[1]!));
  },
  trigger: ')',
  type: 'text-match',
};
