import type { TextMatchTransformer } from '@lexical/markdown';
import { $createMentionNode, MentionNode } from './mention-node';

// 提及的 Markdown 往返：`[@昵称](mention:<user_id>)`（契约见后端方案 §9）。
// 有它才能「存成 Markdown 再读回来还是提及节点」——否则一存一读就退化成普通链接文本。
const PATTERN = /\[@([^\]]+)\]\(mention:(\d+)\)/;

export const MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MentionNode],
  export: (node) =>
    node instanceof MentionNode
      ? '[@' + node.getTextContent().replace(/^@/, '') + '](mention:' + node.getUserId() + ')'
      : null,
  importRegExp: PATTERN,
  regExp: new RegExp(PATTERN.source + '$'),
  replace: (textNode, match) => {
    textNode.replace($createMentionNode(match[1]!, match[2]!));
  },
  trigger: ')',
  type: 'text-match',
};
