import type { CommentData } from '@/ui/comment/types';
import type { IssueKind, IssueStatus, IssueSummary } from '../12-topic/_task/types';

// 本页是**设计验证页**：数据全部是本目录里的 mock（不 fetch、不接 api client）。
// Issue 的领域类型（kind / status / IssueSummary）归 W1 的 12-topic/_task/types **独占定义**，
// 列表行直接用 W1 的 IssueCard（它只认 IssueSummary）；这里只补**详情页**多出来的部分。
// 契约对照（完全重构/论坛后端技术方案-v2.md §21.2「资源帖 issue」）：
//   POST /api/v1/topics/{id}/issues { kind, title, body_md } → kind / title / bodyMarkdown
//   GET  /api/v1/issues/{id} 详情 + 评论 → bodyMarkdown / bodyHtml / comments
//   labels / assignee 契约**目前没有**，见回报的「明确的后端需求变动」。
export type { IssueKind, IssueStatus };

export type IssueDetail = IssueSummary & {
  /** 正文源（Markdown）与已渲染正文（对应契约的 body_md / content_html） */
  bodyMarkdown: string;
  bodyHtml: string;
  /** 标签（契约暂无） */
  labels: string[];
  /** 指派（契约暂无；「指派给我」筛选要用） */
  assignee?: IssueSummary['author'] | null;
};

/** 评论：直接用 @/ui/comment 的 CommentData，不另造一套 */
export type IssueComment = CommentData;
