import {
  $applyNodeReplacement,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';

// 正文里的图片节点。照官方 playground 的 ImageNode：**DecoratorNode**（原子节点），
// 它就是文档内容的一部分——光标能到它前后、退格整块删除、随正文一起序列化。
// 之前把图片只放在上传控件的列表里，那是「附件」不是「正文」。
export type SerializedImageNode = Spread<
  { src: string; alt: string },
  SerializedLexicalNode
>;

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __alt: string;

  constructor(src: string, alt: string, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
  }

  static getType(): string {
    return 'image';
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__alt, node.__key);
  }

  static importJSON(json: SerializedImageNode): ImageNode {
    return $createImageNode(json.src, json.alt);
  }

  exportJSON(): SerializedImageNode {
    return { ...super.exportJSON(), type: 'image', src: this.__src, alt: this.__alt, version: 1 };
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'inline-block align-middle';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  getSrc(): string {
    return this.__src;
  }

  getAlt(): string {
    return this.__alt;
  }

  decorate(): JSX.Element {
    return (
      <img
        src={this.__src}
        alt={this.__alt}
        className='my-2 max-h-80 max-w-full rounded-md border border-border object-contain'
      />
    );
  }
}

export function $createImageNode(src: string, alt = ''): ImageNode {
  return $applyNodeReplacement(new ImageNode(src, alt));
}

/** 数一份 EditorState JSON 里有多少图片节点——**限额要按正文实际内容算**，
 *  按「历史上传过几张」算的话，用户在正文里删掉图片后计数不会降。 */
export function countImageNodes(json: unknown): number {
  let n = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const rec = node as { type?: string; children?: unknown[] };
    if (rec.type === 'image') n++;
    if (Array.isArray(rec.children)) rec.children.forEach(walk);
  };
  walk((json as { root?: unknown }).root);
  return n;
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
