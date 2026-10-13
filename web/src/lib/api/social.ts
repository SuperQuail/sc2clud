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

// **字段名照抄后端 notify/types.go 的 NotificationDTO**。
// 2026-10-13 盲测实测：这里原本写的是 { summary, read }，而线上根本没有这两个字段
// （后端给的是 payload / link / read_at / actor）—— 通知中心因此**渲染出一列空白行**，
// 接口 200、列表有数据，只有文字是空的。契约两侧各写一份、各自的测试都过，序列化那层没人测。
export type Notification = {
  id: string;
  kind: string;
  /** 渲染这一条所需的最小形状（d4 §1.1：不放快照）。已知键：ref_type / ref_id / topic_id / text / state / until / amount_cents */
  payload?: Record<string, unknown> | null;
  /** 站内路径（形如 "/t/<public_id>"），空串 = 这条通知没有落点（例如处罚通知） */
  link: string;
  /** null = 未读。**没有 read 布尔字段** */
  read_at: string | null;
  created_at: string;
  /** null = 触发者已注销（系统通知与 AI 审核也是 null） */
  actor?: { handle: string; nickname: string; avatar?: string | null; avatar_small?: string | null } | null;
};

export function fetchNotifications(q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Notification>> {
  return apiPage<Notification>('notifications', { query: pageQuery(q), signal });
}

export function fetchUnreadCount(signal?: AbortSignal): Promise<{ count: number }> {
  return api<{ count: number }>('notifications/unread-count', { signal });
}

export function markNotificationsRead(body: { ids: string[] } | { all: true }) {
  return api<{ updated: number }>('notifications/read', { method: 'POST', body });
}

/** 软删（只对自己隐藏）。后端对「别人的通知」与「不存在的通知」返回同一个 404，避免枚举。 */
export function deleteNotification(id: string): Promise<null> {
  return api<null>('notifications/' + encodeURIComponent(id), { method: 'DELETE' });
}
