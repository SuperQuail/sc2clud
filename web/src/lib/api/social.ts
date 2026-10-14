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

/**
 * 通知列表。真源 notify/handler.go:31-36 的 listQuery：kind / unread / cursor / limit。
 * kind 走 ?kind=reply|mention|like|reward|review|sanction|system（值域与 notify/kinds.go 逐字一致），
 * 不传 = 全部 —— DevRoom 10-messages 左侧那几档就是靠它分的，原先这个函数只传游标，所以分档做不出来。
 */
export type NotificationQuery = PageQuery & { kind?: string; unread?: boolean };

export function fetchNotifications(q: NotificationQuery = {}, signal?: AbortSignal): Promise<Paged<Notification>> {
  const { kind, unread, ...page } = q;
  return apiPage<Notification>('notifications', { query: { kind, unread, ...pageQuery(page) }, signal });
}

// ── 消息设置（2026-10-14 新增的两个端点，存储层 user_notice_settings 早就在）──────────
// 四项与表里的列一一对应（notify/deps.go 的 NoticeSetting）：alert / reply_scope /
// mention_scope / like_alert。值域只有 all | none —— **没有 followed**：
// 拍板 §8.3 说本产品没有「关注用户」，0018 的 CHECK 就把它从值域里删了。
/**
 * 类型名与 `@/ui/message/notice-settings` 导出的**组件**同名，所以同一屏里两样都要时按全站口径起别名
 * （messages.tsx 的 `type NoticeSettings as NoticeSettingsDTO`）—— 直接改类型名会踩到别人的在途文件。
 */
export type NoticeSettings = {
  alert: boolean;
  reply_scope: 'all' | 'none';
  mention_scope: 'all' | 'none';
  like_alert: boolean;
};

export function fetchNoticeSettings(signal?: AbortSignal): Promise<NoticeSettings> {
  return api<NoticeSettings>('notifications/settings', { signal });
}

/** 全量保存：表就四列，没有「只改一个」的半更新语义（后端也是 PUT 全量）。 */
export function updateNoticeSettings(body: NoticeSettings): Promise<NoticeSettings> {
  return api<NoticeSettings>('notifications/settings', { method: 'PUT', body });
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
