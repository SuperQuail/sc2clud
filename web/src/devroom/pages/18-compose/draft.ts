import { TITLE_MAX, type BoardKey, type ComposeTag } from './data';

// 草稿的形状与「能不能提交」的判据。
// **为什么单独一个文件**：react-refresh 只允许组件文件导出组件（同文件里导出一个普通函数会告警），
// 而这条判据要能被测试直接调用（它是这一页唯一的非平凡逻辑）。
export type Draft = {
  title: string;
  board: BoardKey | null;
  tags: ComposeTag[];
  /** 正文的 Lexical EditorState JSON（真源）；空串 = 还没写 */
  json: string;
  /** 正文 HTML（派生物，后端会再清洗一遍）。预览与提交都看它 */
  html: string;
};

/** 正文的可见字数：HTML 去标签。空编辑器给出的 HTML 是 '<p><br></p>'，所以不能只看长度 */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').trim().length;
}

/** 提交按钮为什么是灰的 —— 返回值里缺项的顺序就是「缺什么」的显示顺序。
 *  返回 null = 可以提交。**空标题 + 空正文 + 没选分区都要各自说出来**（只报一项等于让人猜）。 */
export function disabledReason(draft: Draft): string | null {
  const missing = [
    draft.title.trim().length === 0 ? '标题' : null,
    draft.title.trim().length > TITLE_MAX ? '标题太长（上限 ' + TITLE_MAX + ' 字）' : null,
    draft.board === null ? '分区' : null,
    visibleLength(draft.html) === 0 ? '正文' : null,
  ].filter((x): x is string => x !== null);
  return missing.length === 0 ? null : '还缺：' + missing.join('、');
}
