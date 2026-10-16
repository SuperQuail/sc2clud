import type { IssueKind } from '@/devroom/pages/12-topic/_task/types';
import type { IssueKindDTO } from '@/lib/api/issues';
import type { SortKey } from '@/devroom/pages/13-issue/issue-filter-bar';
import type { Issue as WireIssue } from '@/lib/api/issues';

// 反馈页**取数与筛选**这一小块纯逻辑：类型值域（端点形状 → 界面用的三件）与检索条的常量。
// 为什么单拆：routes/issues.tsx 又顶到 gate:size 的 500 行了，而这一块不取数、不认识 React
// —— 与 _parts/issues-mappers.ts 同一个位置上的同一类东西。
//
// 值域的唯一真源是 `GET /issues/kinds`（后端 issue_kinds 表，拍板 08 · J6）：
// 这里不写死四类，只在「端点还没回来 / 拿不到」时回落到 13-issue/shared 的那份兜底。

/** 条目形状与端点逐字同形（dto.go:303 的 IssueKindDTO），所以端点没回来时兜底那一份也放得进来 */
export type KindOption = IssueKindDTO;

/** 值域之外的值**不发出去**：后端对不认识的 kind 回 400（不是静默当不限）。
 *  端点未回来（known 为空）时先放行 —— 否则刷新那一瞬 `?kind=` 深链会被当成无效丢掉。 */
export function parseKind(v: string | null, known: readonly string[]): IssueKind | undefined {
  if (v === null || v === '') return undefined;
  return known.length === 0 || known.includes(v) ? v : undefined;
}

/** 下拉/入口收下的值再复查一次：本地状态可能停在旧值域上（值域变了、或者 URL 里那个 kind 没了） */
export function withinDomain(kind: IssueKind | undefined, known: readonly string[]): IssueKind | undefined {
  return kind !== undefined && known.includes(kind) ? kind : undefined;
}

/** kind → 中文名。端点的 name 优先，缺了回落前端那份已知话术（resolveKindName 内部再兜一层） */
export function kindNameMap(kinds: readonly KindOption[]): Record<string, string> {
  return Object.fromEntries(kinds.map((k) => [k.key, k.name]));
}

/** 排序文案：**不抄 DevRoom 的 SORT_LABEL** —— 那张稿的 created 是升序（label「最早创建」），
 *  而后端三种排序列全是 DESC（pgsql/issues.go:110-113、157 行 ORDER BY … DESC）。照抄就是一句假话。 */
export const SORT_TEXT: Record<SortKey, string> = {
  updated: '最新更新',
  created: '最新创建',
  old: '最早创建',
  comments: '评论最多',
};

/** D5：顶上两个页签（帖子内容 / 问题反馈）的选中态写在地址上。
 *  写出来的唯一一处是 routes/topic.tsx 的 `onOpenIssue`（`issues?topic=<id>`，缺这个参数 = 反馈页）。 */
export const VIEW_PARAM = 'view';

/** 检索条下面那一行「本页 N 条 · 按 X 排序」的两个数。注意 `rows` 是**已经取回来的页**，
 *  所以这里写的「本页」是实话（还没翻到的页不在里面）。 */
export function listSummary(rows: readonly WireIssue[]): { labelOptions: string[]; topicTitle: string } {
  return { labelOptions: [...new Set(rows.flatMap((r) => r.tags))], topicTitle: rows[0]?.topic_title ?? '' };
}
