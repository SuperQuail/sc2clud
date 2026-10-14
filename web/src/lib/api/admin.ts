import { api, apiPage } from './client';
import { pageQuery, PAGE_LIMIT } from './paging';
// 类型只在 admin-types.ts 定义；这里原样再出口一次，调用方一个 import 就够（省得记哪个类型在哪）。
export type * from './admin-types';

import type {
  AdminUser,
  AdminUserFilter,
  AiConfig,
  AiTestView,
  Announcement,
  AuditFilter,
  AuditItem,
  Banner,
  BatchItem,
  Domain,
  Donation,
  DonationFilter,
  DonationStats,
  MailAccount,
  MailAccountInput,
  NoticeDefault,
  Permission,
  Report,
  ReportFilter,
  ReviewQueueFilter,
  ReviewQueueItem,
  Role,
  SettingItem,
  Title,
} from './admin-types';

// 管理后台的客户端（契约 /api/v1/admin/*，实测清单见 完全重构/进行中/后端接口对账.md 第 1 节）。
// 类型在同目录的 admin-types.ts（体量原因分家）；本文件只放请求函数，每条都注了真源位置。
//
// 权限点（后端 authz 常量）在 routes/admin.tsx 里按屏声明；这里不管权限，只管发请求。

// 管理后台的客户端（契约：/api/v1/admin/*，实测清单见 完全重构/进行中/后端接口对账.md 第 1 节）。
// **字段名一律照 forum/internal/** 的 DTO 抄**，不照 DevRoom 的 mock 抄**（交接单 §2 规则 9）：
// mock 里有 reason / holders / topic_count 这些后端**不存在的字段**，照它写就又是一次
// 「两侧各写一份、各自的测试都过」。所以这个文件里每一条都注了真源位置。
//
// 权限点（后端 authz 常量）在 routes/admin.tsx 里按屏声明，这里不发无谓请求的活不干。

// ── 用户与权限（auth/handler.go，现已实装的）────────────────────────────────
// 真源：forum/internal/auth/service.go（RoleItem / PermItem / MeResult）

export function fetchRoles(signal?: AbortSignal): Promise<Role[]> {
  return api<Role[]>('admin/roles', { signal });
}

export function fetchPermissions(signal?: AbortSignal): Promise<Permission[]> {
  return api<Permission[]>('admin/permissions', { signal });
}

/** 全量替换一个角色的权限矩阵（PATCH /admin/roles/:id/permissions body {perm_keys}）。
 *  真源 auth/handler.go 的 replacePermsReq：空数组 = 清空（不是「不动」）。 */
export function replaceRolePerms(roleId: number, permKeys: string[]): Promise<void> {
  return api<void>('admin/roles/' + roleId + '/permissions', { method: 'PATCH', body: { perm_keys: permKeys } });
}

/** 改一个用户的**基线角色**（唯一真源 users.role_id，拍板 §1.4）。权限点 role.assign。 */
export function setUserRole(userId: string, roleId: number): Promise<void> {
  return api<void>('admin/users/' + encodeURIComponent(userId) + '/role', { method: 'PATCH', body: { role_id: roleId } });
}

/** 追加一个权限点（upsert：同一个点再授 = 覆盖期限与理由，不是 409）。reason 必填。 */
export function grantUserPerm(userId: string, perm: string, reason: string, expiresAt?: string): Promise<void> {
  return api<void>('admin/users/' + encodeURIComponent(userId) + '/permissions/' + encodeURIComponent(perm), {
    method: 'POST',
    body: { reason, expires_at: expiresAt ?? '' },
  });
}

export function revokeUserPerm(userId: string, perm: string): Promise<void> {
  return api<void>('admin/users/' + encodeURIComponent(userId) + '/permissions/' + encodeURIComponent(perm), { method: 'DELETE' });
}

/** 封号 / 解封。真源 auth/handler.go 的 banReq：action 只有 ban | unban。 */
/** 用户列表分页。**后端还没有这条路由**：调它会拿到 404，界面必须如实显示而不是空表。 */
export function fetchUsers(f: AdminUserFilter, signal?: AbortSignal): Promise<{ items: AdminUser[]; next: string | null }> {
  return apiPage<AdminUser>('admin/users', {
    query: {
      q: f.q, status: f.status, activated: f.activated,
      email_verified: f.email_verified, role: f.role, ...pageQuery(f),
    },
    signal,
  });
}

export function banUser(userId: string, action: 'ban' | 'unban', reason: string): Promise<{ status: string; sessions_revoked: number }> {
  return api('admin/users/' + encodeURIComponent(userId) + '/ban', { method: 'POST', body: { action, reason } });
}

/** 踢掉某人的全部会话（封号不带踢；这条是独立的动作）。 */
export function revokeUserSessions(userId: string): Promise<{ revoked: number }> {
  return api('admin/users/' + encodeURIComponent(userId) + '/sessions/revoke', { method: 'POST' });
}

// ── 审核队列（forum/handler.go，已实装）────────────────────────────────────
// 真源：forum/internal/forum/review_queue.go 的 ReviewQueueItemDTO

/** 人工判定。**expected_updated_at 必填**：它是这一层的信任边界（批的必须是你看过的那一份内容）。 */
export function fetchReviewQueue(f: ReviewQueueFilter, signal?: AbortSignal): Promise<{ items: ReviewQueueItem[]; next: string | null }> {
  return apiPage<ReviewQueueItem>('admin/topics', {
    query: { state: f.state, board: f.board, q: f.q, ...pageQuery(f) },
    signal,
  });
}


export function reviewTopic(id: string, action: 'approve' | 'reject', note: string, expectedUpdatedAt: string): Promise<ReviewQueueItem> {
  return api<ReviewQueueItem>('admin/topics/' + encodeURIComponent(id) + '/review', {
    method: 'POST',
    body: { action, note, expected_updated_at: expectedUpdatedAt },
  });
}

// ── 举报（report/dto.go）──────────────────────────────────────────────────
// 字段名照 Report 抄：**target_label**（不是 mock 里的 target_title —— 那个错名让每行标题恒空白）

export function fetchReports(f: ReportFilter, signal?: AbortSignal): Promise<{ items: Report[]; next: string | null }> {
  return apiPage<Report>('admin/reports', { query: { state: f.state, target_type: f.target_type, ...pageQuery(f) }, signal });
}

export function handleReport(id: string, state: 'handled' | 'dismissed', note: string): Promise<Report> {
  return api<Report>('admin/reports/' + encodeURIComponent(id), { method: 'PATCH', body: { state, note } });
}

// ── 打赏核验（reward/dto.go）─────────────────────────────────────────────

/** 用户列表分页。**后端还没有这条路由**：调它会拿到 404，界面必须如实显示而不是空表。 */

/** 批量处理：一个事务 + 逐条 CAS + **逐条结果**（别指望整批原子回滚）。 */
export function handleReportsBatch(ids: string[], state: 'handled' | 'dismissed', note: string): Promise<{ results: BatchItem[] }> {
  return api('admin/reports/batch', { method: 'POST', body: { ids, state, note } });
}

/** 用户列表分页。**后端还没有这条路由**：调它会拿到 404，界面必须如实显示而不是空表。 */

/** 批量处理：一个事务 + 逐条 CAS + **逐条结果**（别指望整批原子回滚）。 */

/** 队列的包络是 **{data, next_cursor}**（reward 用 httpx.OKPage）。 */
export function fetchDonations(f: DonationFilter, signal?: AbortSignal): Promise<{ items: Donation[]; next: string | null }> {
  return apiPage<Donation>('admin/rewards', { query: { state: f.state, ...pageQuery(f) }, signal });
}

export function verifyDonation(id: string, state: 'approved' | 'rejected', note: string): Promise<Donation> {
  return api<Donation>('admin/rewards/' + encodeURIComponent(id) + '/verify', { method: 'POST', body: { state, note } });
}

export function verifyDonationsBatch(ids: string[], state: 'approved' | 'rejected', note: string): Promise<{ results: BatchItem[] }> {
  return api('admin/rewards/batch', { method: 'POST', body: { ids, state, note } });
}

export function fetchDonationStats(top = 10, signal?: AbortSignal): Promise<DonationStats> {
  return api<DonationStats>('admin/rewards/stats', { query: { top }, signal });
}

export function fetchNoticeDefaults(signal?: AbortSignal): Promise<NoticeDefault[]> {
  return api<NoticeDefault[]>('admin/donation-notice-defaults', { signal });
}

export function saveNoticeDefaults(items: NoticeDefault[]): Promise<NoticeDefault[]> {
  return api<NoticeDefault[]>('admin/donation-notice-defaults', { method: 'PATCH', body: { items } });
}

// ── 头衔目录（title/types.go）─────────────────────────────────────────────
// 归档不删：archived_at 非空 = 已归档（后端字段，不是 mock 的 archived 布尔）

export function fetchTitles(signal?: AbortSignal): Promise<Title[]> {
  return api<Title[]>('admin/titles', { signal });
}

export function createTitle(b: { key: string; name: string; color: string; description: string }): Promise<Title> {
  return api<Title>('admin/titles', { method: 'POST', body: { ...b, archived: false } });
}

export function updateTitle(id: string, b: { key: string; name: string; color: string; description: string; archived: boolean }): Promise<Title> {
  return api<Title>('admin/titles/' + encodeURIComponent(id), { method: 'PATCH', body: b });
}

export function grantTitle(userId: string, titleId: string): Promise<void> {
  return api<void>('admin/users/' + encodeURIComponent(userId) + '/titles/' + encodeURIComponent(titleId), { method: 'POST' });
}

export function revokeTitle(userId: string, titleId: string): Promise<void> {
  return api<void>('admin/users/' + encodeURIComponent(userId) + '/titles/' + encodeURIComponent(titleId), { method: 'DELETE' });
}

// ── 发信账号（mail/dto.go）────────────────────────────────────────────────
// **密钥只写不回显**：AdminAccount 里只有 secret_configured / secret_updated_at

export function fetchMailAccounts(signal?: AbortSignal): Promise<MailAccount[]> {
  return api<MailAccount[]>('admin/mail/accounts', { signal });
}

export function createMailAccount(b: MailAccountInput): Promise<MailAccount> {
  return api<MailAccount>('admin/mail/accounts', { method: 'POST', body: b });
}

/** 部分更新：**只写传进来的字段**（nil = 不动）。secret 传了就换密钥，不传就保持原样。 */
export function updateMailAccount(id: string, b: Partial<MailAccountInput>): Promise<MailAccount> {
  return api<MailAccount>('admin/mail/accounts/' + encodeURIComponent(id), { method: 'PATCH', body: b });
}

export function deleteMailAccount(id: string): Promise<{ archived: boolean }> {
  return api('admin/mail/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
}

export function testMailAccount(id: string, to: string): Promise<{ mail_log_id: number }> {
  return api('admin/mail/accounts/' + encodeURIComponent(id) + '/test', { method: 'POST', body: { to } });
}

// ── 站点设置（site/dto.go）────────────────────────────────────────────────
// SettingItem 自带 label / kind / options / value / hint —— 键值目录是**后端给的**，
// 前端不再自己维护一张「有哪些键」的表（那样两边必然漂移）。

export function fetchSiteSettings(signal?: AbortSignal): Promise<SettingItem[]> {
  return api<{ items: SettingItem[] }>('admin/site-settings', { signal }).then((r) => r.items);
}

/** 只写传进来的键（SettingsInput.values 是 map）。 */
export function saveSiteSettings(values: Record<string, string>): Promise<void> {
  return api<void>('admin/site-settings', { method: 'PATCH', body: { values } });
}

/** 只读：真源是配置里的 base_url（拍板 §8.11 U2）。 */
export function fetchDomains(signal?: AbortSignal): Promise<Domain[]> {
  return api<Domain[]>('admin/site-domains', { signal });
}

export function fetchAnnouncements(signal?: AbortSignal): Promise<Announcement[]> {
  return api<Announcement[]>('admin/announcements', { signal });
}

export function createAnnouncement(b: { title: string; body_md: string; enabled?: boolean; publish?: boolean }): Promise<Announcement> {
  return api<Announcement>('admin/announcements', { method: 'POST', body: b });
}

export function updateAnnouncement(id: string, b: { title?: string; body_md?: string; enabled?: boolean; publish?: boolean }): Promise<Announcement> {
  return api<Announcement>('admin/announcements/' + encodeURIComponent(id), { method: 'PATCH', body: b });
}

export function fetchBanners(signal?: AbortSignal): Promise<Banner[]> {
  return api<Banner[]>('admin/banners', { signal });
}

export function createBanner(b: { kind: string; text: string; url?: string; enabled?: boolean; roles?: string[] }): Promise<Banner> {
  return api<Banner>('admin/banners', { method: 'POST', body: b });
}

export function updateBanner(
  id: string,
  b: { kind?: string; text?: string; url?: string; enabled?: boolean; roles?: string[]; clear_ends_at?: boolean },
): Promise<Banner> {
  return api<Banner>('admin/banners/' + encodeURIComponent(id), { method: 'PATCH', body: b });
}

// ── 审计日志（auth/audit.go）─────────────────────────────────────────────

/** 导出 CSV：浏览器直接下文件，不走 fetch（前端方案 §5 的 fetch 唯一出口管不到它）。 */
export function fetchAuditLogs(f: AuditFilter, signal?: AbortSignal): Promise<{ items: AuditItem[]; next: string | null }> {
  return apiPage<AuditItem>('admin/audit-logs', {
    query: {
      target_type: f.target_type, target_id: f.target_id, action: f.action,
      actor: f.actor, from: f.from, to: f.to, ...pageQuery(f),
    },
    signal,
  });
}

export function auditExportUrl(base: string, f: Omit<AuditFilter, 'limit' | 'cursor'>): string {
  const p = new URLSearchParams({ format: 'csv' });
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
  return base.replace(/\/+$/, '') + '/api/v1/admin/audit-logs/export?' + p.toString();
}

// ── AI 审核（aireview/dto.go）─────────────────────────────────────────────
// 字段名照 ConfigView 抄；**密钥永不回显**，只有 has_secret（d7 §8 验收 12）

export function fetchAiConfig(signal?: AbortSignal): Promise<AiConfig> {
  return api<AiConfig>('admin/ai/config', { signal });
}

/** 部分更新：nil = 不动。密钥不在这里（走 saveAiSecret）。 */
export function patchAiConfig(b: Partial<Omit<AiConfig, 'has_secret' | 'secret_updated_at' | 'last_ok_at' | 'last_error' | 'last_error_at'>>): Promise<AiConfig> {
  return api<AiConfig>('admin/ai/config', { method: 'PATCH', body: b });
}

/** 只写不回显。 */
export function saveAiSecret(apiKey: string): Promise<{ has_secret: boolean }> {
  return api('admin/ai/config/secret', { method: 'POST', body: { api_key: apiKey } });
}

export function testAiConfig(): Promise<AiTestView> {
  return api<AiTestView>('admin/ai/test', { method: 'POST' });
}

export { PAGE_LIMIT };

