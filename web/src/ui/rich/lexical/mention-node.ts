import { $applyNodeReplacement, TextNode, type EditorConfig, type NodeKey, type SerializedTextNode, type Spread } from 'lexical';

// @提及节点。继承 TextNode，但 **`isTextEntity()` 让它成为「一个整体」**：
// 光标不会停在它中间、退格一次删掉整块——照官方 playground 的 MentionNode（segmented 模式）。
// 用 LinkNode 是错的：那只是「带链接的文本」，退格只能删一个字。
export class MentionNode extends TextNode {
  __userId: string;

  constructor(text: string, userId: string, key?: NodeKey) {
    super(text, key);
    this.__userId = userId;
  }

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__text, node.__userId, node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config);
    el.dataset.mention = this.__userId;
    el.className = 'mention-chip';
    return el;
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  getUserId(): string {
    return this.__userId;
  }

  exportJSON(): Spread<{ userId: string }, SerializedTextNode> {
    return { ...super.exportJSON(), type: 'mention', userId: this.__userId, version: 1 };
  }

  static importJSON(json: Spread<{ userId: string }, SerializedTextNode>): MentionNode {
    return new MentionNode(json.text, json.userId);
  }
}

export function $createMentionNode(nickname: string, userId: string): MentionNode {
  const node = new MentionNode('@' + nickname, userId);
  // `segmented` 才是「整块」的真正机制：光标不进内部、退格一次删整块。
  // 官方 playground 的 MentionNode 就是这么写的（isTextEntity 只管插入边界，管不了删除）。
  node.setMode('segmented').toggleDirectionless();
  return $applyNodeReplacement(node);
}

export function $isMentionNode(node: unknown): node is MentionNode {
  return node instanceof MentionNode;
}
