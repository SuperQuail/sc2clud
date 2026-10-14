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

// ── C4 申诉闭环（2026-10-14 落地；端点见 forum/internal/appeal/handler.go）────────────────
//
// **字段名照抄后端 DTO**（forum/internal/appeal/dto.go 的 Appeal / SubmitResult）。
// 免登录那两条路（提交 / 查进展）是 C4 存在的理由：被封的人登不进来。
// 设计稿 17-appeal 的四态在服务端是三值 + decision —— 「已驳回」= decision='upheld'。

/** 事由值域与 0022_appeals 的 ck_appeals_type 逐字一致（也等于 17-appeal/data.ts 的四个 key）。 */
export type AppealKind = 'ban' | 'review_reject' | 'report_result' | 'other';

/** 状态三值。**没有第四态「已驳回」**：那由 decision 表达（见上）。 */
export type AppealState = 'pending' | 'replied' | 'closed';

export type AppealDecision = 'upheld' | 'overturned';

export type Appeal = {
  /** 对外单号（AP-2001）。它同时是免登录查进展的凭据之一。 */
  no: string;
  type: AppealKind;
  username: string;
  email: string;
  /** 自证通过后绑上的账号（公开 id）；null = 没对上，要人眼核。 */
  user_id: string | null;
  identity_verified: boolean;
  /** 只有 review_reject 有（那篇被驳回的帖子）。 */
  topic_id: string | null;
  /** 那篇帖子**此刻**的审核态（pending / approved / rejected）。 */
  topic_review_state: string | null;
  ref: string;
  title: string;
  details: string;
  contact: string;
  status: AppealState;
  decision: AppealDecision | null;
  /** 给提交人看的答复（离开 pending 时一定非空）。 */
  response: string;
  handle_note: string;
  handler: { handle: string; nickname: string } | null;
  handled_at: string | null;
  /** 答复时限（后端给的文案，如「3 个工作日内」）—— 别在前端再写一份。 */
  eta: string;
  created_at: string;
  updated_at: string;
};

export type AppealReceipt = { no: string; eta: string; status: AppealState; created: boolean };

/** POST /appeals —— **免登录**。登录了也能发（会话是更强的证据）。 */
export function createAppeal(body: {
  type: AppealKind;
  username?: string;
  email: string;
  ref?: string;
  title: string;
  details: string;
  contact?: string;
  /** 这一张题的 id（ProductCaptcha 的 onChallenge 给）。缺了后端判 auth.captcha_wrong。 */
  captcha_id?: string;
  captcha?: string;
}): Promise<AppealReceipt> {
  return api<AppealReceipt>('appeals', { method: 'POST', body });
}

/** POST /appeals/lookup —— 免登录查进展：**单号 + 注册邮箱**，两条都对上才给看。 */
export function lookupAppeal(body: { no: string; email: string }): Promise<Appeal> {
  return api<Appeal>('appeals/lookup', { method: 'POST', body });
}

/** GET /me/appeals —— 登录用户看自己全部（含已处理）。 */
export function fetchMyAppeals(q: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return apiPage<Appeal>('me/appeals', { query: pageQuery(q), signal });
}

/** 管理端队列的筛选（字段名照 handler.go 的 QueueInput）。 */
export type AppealQueueQuery = PageQuery & { status?: AppealState; type?: AppealKind; q?: string };

export function fetchAppealQueue(q: AppealQueueQuery = {}, signal?: AbortSignal): Promise<{ items: Appeal[]; next: string | null }> {
  const { status, type, q: keyword, ...page } = q;
  return apiPage<Appeal>('admin/appeals', { query: { status, type, q: keyword, ...pageQuery(page) }, signal });
}

/**
 * PATCH /admin/appeals —— 处理一条（体里带单号）。
 * response **必填**：处理了却不给答复正是这条链路要消灭的形态。
 * decision='overturned' 额外要 post.review 权限（它会真的放行那篇帖子）。
 */
export function decideAppeal(body: {
  no: string;
  decision: AppealDecision;
  response: string;
  note?: string;
  close?: boolean;
}): Promise<Appeal> {
  return api<Appeal>('admin/appeals', { method: 'PATCH', body });
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

/**
 * 「不再通知」——按**类别**静音（PUT /notifications/mutes）。
 * 字段名照 notify/handler.go:126-130 的 muteBody；按类别时**只能带 type**
 * （muteKey 对「整类静音带 ref_type/ref_id」直接 400），ref_type / ref_id 是给 type='link' 用的。
 *
 * 为什么界面上只做类别静音、不做「这条内容不再通知」（2026-10-14 实测契约）：
 * 按内容静音要 target_key = "<ref_type>:<内部 id>"，而通知 DTO 的 payload.ref_id 是**内部 id**
 * （notify/types.go 的 RefID 注释），前端拿不到 public id 与它的换算 —— 送进去就是永久静音一条
 * 别人永远碰不到的通知（看起来成功、实际什么都没发生）。类别静音是唯一端到端可用的那一档；
 * 代价：点「回复我的」上的这颗按钮会静音**全部**回复通知，所以界面上的文案必须写清是「此类」。
 *
 * 幂等：重复 PUT 是 204。后端**没有** GET /mutes，所以列表里无法显示「已静音」——
 * 那是要补的端点（记在 完全重构/进行中/进度-W-GE.md 的阻塞里）。
 */
export function muteNotificationKind(type: string): Promise<null> {
  return api<null>('notifications/mutes', { method: 'PUT', body: { type } });
}

/**
 * 取消按内容静音（DELETE /notifications/mutes）。**产品里目前没有落点**：
 * 能取消的是「按内容静音」，而界面只做类别静音（理由见上）。
 * 留着它是因为契约两侧各写一份是本仓库最高频的事故，而这一对函数与 muteBody 同源、一并被单测钉住。
 */
export function clearNotificationMute(body: { type: string; ref_type?: string; ref_id?: number }): Promise<null> {
  return api<null>('notifications/mutes', { method: 'DELETE', body });
}