import type { UserSummary } from '@/ui/user/user-badge';

// 帖子详情页的 Issue（资源帖的反馈/建议）领域类型。
// 字段名以后端契约 完全重构/论坛后端技术方案-v2.md §21.2「资源帖 issue」段为准：
//   kind / title / status 与接口逐字同名（POST /api/v1/topics/{id}/issues 的 { kind, title, body_md }）；
//   列表接口（GET /api/v1/topics/{id}/issues?status=open|closed）另给计数与时间戳，这里按前端惯用名收口：
//   commentCount ← 评论数、createdAt ← created_at、updatedAt ← updated_at（都是后端已格式化好的展示串）。
// 为什么 IssueSummary 不含 body_md：列表项只渲染摘要行，正文/评论在 GET /api/v1/issues/{id} 详情里取。
export type IssueKind = 'bug' | 'feature' | 'difficulty' | 'other';

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

// 四类反馈的固定文案：**标签与服务端 kind 一一对应**，前端不再自己拼词。
// description 用在一句话说明（入口按钮的 aria-label / title），所以它是契约的一部分。
export const ISSUE_KIND_META: Record<IssueKind, { label: string; description: string }> = {
  bug: { label: '报个 Bug', description: '卡住、崩溃、AI 不动、地图打不开这类「不对」的事' },
  feature: { label: '功能建议', description: '希望站点或战役多一个什么能力' },
  difficulty: { label: '难度建议', description: '哪一关太难或太简单，节奏、资源、强度都能提' },
  other: { label: '其他反馈', description: '上面三类都不是的，随便说' },
};

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = { open: '开启中', closed: '已关闭' };
