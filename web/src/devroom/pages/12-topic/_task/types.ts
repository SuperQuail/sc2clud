import type { UserSummary } from '@/ui/user/user-badge';

// 帖子详情页的 Issue（资源帖的反馈/建议）领域类型。
// 字段名以后端契约 完全重构/论坛后端技术方案-v2.md §21.2「资源帖 issue」段为准：
//   kind / title / status 与接口逐字同名（POST /api/v1/topics/{id}/issues 的 { kind, title, body_md }）；
//   列表接口（GET /api/v1/topics/{id}/issues?status=open|closed）另给计数与时间戳，这里按前端惯用名收口：
//   commentCount ← 评论数、createdAt ← created_at、updatedAt ← updated_at（都是后端已格式化好的展示串）。
// 为什么 IssueSummary 不含 body_md：列表项只渲染摘要行，正文/评论在 GET /api/v1/issues/{id} 详情里取。
/** 类型值是**数据驱动**的（后端 issue_kinds 表，`GET /issues/kinds`，拍板 08 · J6）——
 *  所以这里不是四种字面量的联合：加一类之后界面（入口 / 下拉 / 标签）跟着端点走，不发版。
 *  key → 中文名一律走 resolveKindName()，别在组件里直接下标 ISSUE_KIND_META。 */
export type IssueKind = string;

export type IssueStatus = 'open' | 'closed';

export type IssueSummary = {
  id: number | string;
  kind: IssueKind;
  title: string;
  status: IssueStatus;
  author: UserSummary;
  commentCount: number;
  /** 展示用时间串（“3 分钟前”“2026-10-12”） */
  createdAt: string;
  /** 展示用时间串，列表按它倒序 */
  updatedAt: string;
};

// 四类**已知** kind 的话术：入口按钮那句说明（aria-label / title）是契约的一部分，所以留在这里。
//
// 它**不是值域**（值域只有 `GET /issues/kinds` 一处）：新加的一类在这里没有条目，
// 于是入口按钮拿端点的 name 当标签、说明回落成一句通用话术 —— 而不是崩掉或者显示一个英文 key。
// 也正因为它不再是封闭表，类型是 Partial：下标可能 undefined，逼调用方走 resolveKindName()。
// description 保持在**数据之外**：端点只给 name，多一类不要求后端补一句人话。
export const ISSUE_KIND_META: Partial<Record<IssueKind, { label: string; description: string }>> = {
  bug: { label: '汇报 Bug', description: '卡住、崩溃、AI 不动、地图打不开这类「不对」的事' },
  feature: { label: '功能建议', description: '希望站点或战役多一个什么能力' },
  difficulty: { label: '难度建议', description: '哪一关太难或太简单，节奏、资源、强度都能提' },
  other: { label: '其他反馈', description: '上面三类都不是的，随便说' },
};

/** kind → 界面上的中文名。**端点的 name 优先**（值域归后端），前端这份只兜底没拿到端点时的那一瞬。 */
export function resolveKindName(kind: IssueKind, fromEndpoint?: string): string {
  return fromEndpoint ?? ISSUE_KIND_META[kind]?.label ?? kind;
}

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = { open: '开启中', closed: '已关闭' };
