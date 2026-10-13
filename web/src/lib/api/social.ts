import { api, apiPage } from './client';
import type { Paged } from './forum';
import { pageQuery, type PageQuery } from './paging';

// 社交与工单域：举报、申诉、通知（v2 §21.2 的 report / appeal / notify 部分）。
// **申诉两条路**（完全重构/盲审合并结论.md §7）：
//   ① 帖子里点「申请人工复核」→ POST /api/v1/topics/{id}/review/appeal（拍板 §10.10-1，登录 + 仅作者）；
//   ② 被封的人登不进来 → 免登录的申诉链路（用户名 + 注册邮箱 + 图形验证码自证）。
// ②的端点**在 §21.2 里没有**（已写进回报的端点清单），所以这里只有①。

export type AppealType = 'ban' | 'review_reject' | 'report_result' | 'other';

export type ReportTarget = 'topic' | 'post' | 'user';

/** §21.2：{ target_type, target_id, reason }；事由值域后端是 varchar(500) 无 CHECK（上线设计 §3 第 6 条） */
export function createReport(body: { target_type: ReportTarget; target_id: string; reason: string }) {
  return api<{ id: string }>('reports', { method: 'POST', body });
}

/** 帖子的作者申诉（拍板 §10.10-1：幂等，重复提交返回既有状态） */
export function appealTopicReview(topicId: string, body: { reason: string }): Promise<{ status: string }> {
  return api<{ status: string }>('topics/' + encodeURIComponent(topicId) + '/review/appeal', {
    method: 'POST',
    body,
  });
}

export type Notification = {
  id: string;
  kind: string;
  actor?: { handle: string; nickname: string; avatar?: string | null };
  summary: string;
  read: boolean;
  created_at: string;
};

export function fetchNotifications(q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Notification>> {
  return apiPage<Notification>('notifications', { query: pageQuery(q), signal });
}

export function fetchUnreadCount(signal?: AbortSignal): Promise<{ count: number }> {
  return api<{ count: number }>('notifications/unread-count', { signal });
}

export function markNotificationsRead(body: { ids: string[] } | { all: true }) {
  return api<void>('notifications/read', { method: 'POST', body });
}
