import { api, apiEnvelope, apiPage } from './client';
import { pageQuery, PAGE_LIMIT } from './paging';
// 类型只在 admin-types.ts 定义；这里原样再出口一次，调用方一个 import 就够（省得记哪个类型在哪）。
export type * from './admin-types';

import type {
  AdminACLItem,
  AdminBoard,
  AiPayloadView,
  AdminModeratorItem,
  AdminUser,
  AdminUserDetail,
  AdminUserFilter,
  AiConfig,
  AiTestView,
  Announcement,
  AuditFilter,
  AuditItem,
  Banner,
  BatchItem,
  CreateBoardInput,
  Diagnostics,
  Domain,
  Donation,
  DonationFilter,
  DonationStats,
  MailAccount,
  MailAccountInput,
  MailTemplate,
  MailTemplateInput,
  MailTemplatePreview,
  NoticeDefault,
  Permission,
  Report,
  ReportFilter,
  ReviewQueueFilter,
  ReviewQueueItem,
  Role,
  SettingItem,
  Title,
  UpdateBoardInput,
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

/** 用户列表的包络（v2 才给 counts）。字段名照 auth 的 AdminUsersCountsDTO 抄。 */
export type AdminUsersPage = {
  items: AdminUser[];
  next: string | null;
  /** **整个筛选结果集**的计数（不是本页条数）。服务端没给时是 0 —— 屏上宁可为 0 也不假装。 */
  counts: { total: number; banned: number; pending_activation: number; email_unverified: number };
};

/** 用户列表分页（C1 已落地）。筛选三根状态轴照 auth/handler.go 的 adminUsersQueryReq。
 *
 *  **v=2 是必须的**：只有它回 counts（总数与三根轴的计数）。不带 v 时后端给的是老包络
 *  {data, next_cursor}，前端就拿不到总人数 —— 这正是用户报的「看不到总人数」。
 *  包络版本化而不是直接加字段，是为了不改老客户端的契约（后端也有用例钉住这一点）。 */
export function fetchUsers(f: AdminUserFilter, signal?: AbortSignal): Promise<AdminUsersPage> {
  // 走 apiEnvelope 而不是 apiPage：counts 是 data **外面**的第三个字段，apiPage 只解 data 与 next_cursor
  // （私信会话页的 peer 也是同一形状，见 client.ts 的注）。这里就地解包络，少一个只此一用的函数。
  return apiEnvelope<{ data?: AdminUser[]; next_cursor?: string | null; counts?: AdminUsersPage['counts'] }>('admin/users', {
    query: {
      q: f.q, status: f.status, activated: f.activated,
      email_verified: f.email_verified, role: f.role, v: '2', ...pageQuery(f),
    },
    signal,
  }).then((p) => ({
    items: p.data ?? [],
    next: p.next_cursor ?? null,
    counts: p.counts ?? { total: 0, banned: 0, pending_activation: 0, email_unverified: 0 },
  }));
}

/** 封号 / 解封。真源 auth/handler.go 的 banReq：action 只有 ban | unban。 */
export function banUser(userId: string, action: 'ban' | 'unban', reason: string): Promise<{ status: string; sessions_revoked: number }> {
  return api('admin/users/' + encodeURIComponent(userId) + '/ban', { method: 'POST', body: { action, reason } });
}

/** 踢掉某人的全部会话（封号不带踢；这条是独立的动作）。 */
/** 手工激活一个用户（D29）：站点关掉自动激活后管理员唯一的激活入口。
 *  真源 auth/handler.go 的 POST /admin/users/batch 的 action=activate → ActivateUser：
 *  **只写 activated_at**，不动 email_verified_at（手工激活 ≠ 邮箱验证）。幂等。 */
export function activateUser(userId: string, reason = ''): Promise<void> {
  return api<void>('admin/users/batch', { method: 'POST', body: { ids: [userId], action: 'activate', reason } });
}

export function revokeUserSessions(userId: string): Promise<{ revoked: number }> {
  return api('admin/users/' + encodeURIComponent(userId) + '/sessions/revoke', { method: 'POST' });
}

/** 用户详情：列表项 + 三张关联表（sanctions / user_permissions / user_titles）。**只有这条给那三张表**。 */
export function fetchUserDetail(userId: string, signal?: AbortSignal): Promise<AdminUserDetail> {
  return api<AdminUserDetail>('admin/users/' + encodeURIComponent(userId), { signal });
}

// ── 分区管理（forum/admin_boards.go + handler_admin_boards.go，C2 已落地）──────
// 九条路由一个形状：列表/读不翻页（后台分区数量是几十，不是几万），ACL 与版主按分区取。

/** 后台分区列表，**含归档**（公开列表只给 active）。 */
export function fetchAdminBoards(signal?: AbortSignal): Promise<AdminBoard[]> {
  return api<AdminBoard[]>('admin/boards', { signal });
}

/** 建分区。slug 建后不可改（改 slug = 废掉所有外链），所以只有这里能传。 */
export function createBoard(b: CreateBoardInput): Promise<AdminBoard> {
  return api<AdminBoard>('admin/boards', { method: 'POST', body: b });
}

/** 改分区：**只发改动过的字段**（后端 UpdateBoardInput 全是指针，没发的键不动；空 body 400）。 */
export function updateBoard(id: string, b: UpdateBoardInput): Promise<AdminBoard> {
  return api<AdminBoard>('admin/boards/' + encodeURIComponent(id), { method: 'PATCH', body: b });
}

/** 重排：**必须给全部**分区的 id 且不重复 —— 少一个就会有分区留在原 sort 上与别人撞在一起。 */
/**
 * 换分区封面：先走**图片通道**（POST /me/cover，与个人主页封面同一条）拿到 hash，
 * 再把它 PATCH 到 boards.cover_hash（见 routes/admin/boards.tsx 的 coverUpload）。
 *
 * 为什么不在 admin 域再开一个上传端点：那要复制一份 multipart 解析、体积闸门与内容哈希落盘，
 * 而这两件事 media 域已经各有一份了（d5 §2.3）。09 收尾对照表 §3.8 那条「图片通道没做」现在可以划掉。
 */
export function uploadBoardCover(file: Blob): Promise<{ hash: string; url: string }> {
  const form = new FormData();
  form.append('file', file, 'board-cover.webp');
  return api<{ hash: string; url: string }>('me/cover', { method: 'POST', body: form });
}

/** 重排：**必须给全部** 分区的 id 且不重复 —— 少一个就会有分区留在原 sort 上与别人撞在一起。 */
export function reorderBoards(ids: string[]): Promise<void> {
  return api<void>('admin/boards/reorder', { method: 'POST', body: { ids } });
}

export function fetchBoardAcl(id: string, signal?: AbortSignal): Promise<AdminACLItem[]> {
  return api<AdminACLItem[]>('admin/boards/' + encodeURIComponent(id) + '/acl', { signal });
}

/** ACL **全量替换**（逐格 PATCH 会暴露「禁止优先」的中间态）。空数组 = 清空整张矩阵。
 *  同一行既 can 又 deny、重复 role_id、角色不存在都是 400（后端逐条校验，不静默）。 */
export function replaceBoardAcl(id: string, acls: AdminACLItem[]): Promise<AdminACLItem[]> {
  return api<AdminACLItem[]>('admin/boards/' + encodeURIComponent(id) + '/acl', { method: 'PUT', body: { acls } });
}

/** 版主名单：**含已卸任的历史行**（grown_at 非空）。划过期的行不删，所以「谁什么时候被免的」答得出来。 */
export function fetchBoardModerators(id: string, signal?: AbortSignal): Promise<AdminModeratorItem[]> {
  return api<AdminModeratorItem[]>('admin/boards/' + encodeURIComponent(id) + '/moderators', { signal });
}

/** 任命版主（幂等：重复任命 = 改任期）。expires_at 为 RFC3339，空串 = 永久；给了必须是将来。 */
export function grantBoardModerator(id: string, userId: string, expiresAt?: string): Promise<AdminModeratorItem[]> {
  return api<AdminModeratorItem[]>('admin/boards/' + encodeURIComponent(id) + '/moderators', {
    method: 'POST',
    body: { user_id: userId, expires_at: expiresAt ?? '' },
  });
}

export function revokeBoardModerator(id: string, userId: string): Promise<void> {
  return api<void>('admin/boards/' + encodeURIComponent(id) + '/moderators/' + encodeURIComponent(userId), { method: 'DELETE' });
}

// ── 自检面板（auth/admin_diagnostics.go，C3 已落地）────────────────────────
// **debug 关掉时整体 404**（common.not_found），不是空 200 —— 那个 404 必须如实显示。

export function fetchDiagnostics(signal?: AbortSignal): Promise<Diagnostics> {
  return api<Diagnostics>('admin/diagnostics', { signal });
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


/** 判定动作（forum/review_queue.go 的 reviewQueueActions）：
 *  approve 放行（有草稿时 = 把改动替换上线）、reject 拒绝、request_revision 打回修改。
 *  第四个状态 revision_requested 就是打回，与 rejected 是两档（拍板 08 · L6）。 */
export type ReviewAction = 'approve' | 'reject' | 'request_revision';

export function reviewTopic(id: string, action: ReviewAction, note: string, expectedUpdatedAt: string): Promise<ReviewQueueItem> {
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

/** 批量处理：一个事务 + 逐条 CAS + **逐条结果**（别指望整批原子回滚）。 */
export function handleReportsBatch(ids: string[], state: 'handled' | 'dismissed', note: string): Promise<{ results: BatchItem[] }> {
  return api('admin/reports/batch', { method: 'POST', body: { ids, state, note } });
}

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

// ── 邮件模板（D37，mail/templates.go）────────────────────────────────────
// 列表一次给四行（缺行的回落内置源 —— 编辑框先填成现状），four rows 不翻页。

export function fetchMailTemplates(signal?: AbortSignal): Promise<MailTemplate[]> {
  return api<MailTemplate[]>('admin/mail-templates', { signal });
}

/** 全量三段一起写；编译不过后端回 400 + fields（字段名对上编辑框，错误原话带行位）。 */
export function saveMailTemplate(kind: string, b: MailTemplateInput): Promise<MailTemplate> {
  return api<MailTemplate>('admin/mail-templates/' + encodeURIComponent(kind), { method: 'PUT', body: b });
}

/** 恢复内置：删行，下一次渲染落回 embed（幂等）。 */
export function resetMailTemplate(kind: string): Promise<MailTemplate> {
  return api<MailTemplate>('admin/mail-templates/' + encodeURIComponent(kind), { method: 'DELETE' });
}

/** 预览 = 把编辑框里还没保存的那份实渲染一遍；三段可选，空的段回落内置。 */
export function previewMailTemplate(b: { kind: string } & Partial<MailTemplateInput>): Promise<MailTemplatePreview> {
  return api<MailTemplatePreview>('admin/mail-templates/preview', { method: 'POST', body: b });
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

/** 「真正发给模型的那一份」的组装口（D33①，dry-run，**一次外呼都不发**）。
 *
 *  两种来源共用这一条：`topicId` 给了就读那条真帖子（服务端按 sqlSubject 现读正文，客户端塞不进
 *  一份「和真发的不一样」的正文）；不给就回连通测试的样例（`probe` 可临时覆盖那一段）。
 *  **前端只渲染它的回执** —— 自己拼第二份 payload 就是两份真源，那正是这个屏要消灭的形态。 */
export function fetchAiPayload(req: { topicPublicId?: string; trigger?: string; probe?: string }, signal?: AbortSignal, files?: File[]): Promise<AiPayloadView> {
  // D34：带样例图的干跑走 multipart（与 test 同一条表单口）；不带图照旧 JSON。
  if (files?.length) {
    return api<AiPayloadView>('admin/ai/payload', { method: 'POST', body: probeForm(req.probe ?? '', files), signal });
  }
  return api<AiPayloadView>('admin/ai/payload', {
    method: 'POST',
    // **topic_public_id 是唯一的对外寻址方式**（真源 aireview/dto.go 的 payloadReq）：
    // 管理端手上只有 uuid（队列 DTO 的 id 就是 topics.public_id），内部自增 id 不跨端。
    body: { topic_public_id: req.topicPublicId ?? '', trigger: req.trigger ?? '', probe: req.probe ?? '' },
    signal,
  });
}

/** 连通测试。
 *  `probe` 是**这一次**要发的样例（空 = 后端的内置默认样例）：只影响这一次，**不落库**。
 *  `topicId` 给了就真发一次这条帖子的 payload（**带图**），回执里会多出 image_count / images[] ——
 *  这是「图片审核到底起不起效」唯一的当场证据（D33③）。 */
export function testAiConfig(probe?: string, topicPublicId?: string, files?: File[]): Promise<AiTestView> {
  // D34：带了样例图就走 multipart（probe 文本 + file 部件）——client.ts 的 request 对 FormData body
  // 本来就不套 JSON（头像上传同一形态），错误包络仍是同一个解析（isApiError 可判）。
  // 没带图保持**旧 JSON 路径一字不改**（topic_public_id 的试跑也在这里）。
  if (files?.length) {
    return api<AiTestView>('admin/ai/test', { method: 'POST', body: probeForm(probe ?? '', files) });
  }
  return api<AiTestView>('admin/ai/test', { method: 'POST', body: { probe: probe ?? '', topic_public_id: topicPublicId ?? '' } });
}

/** D34 的 multipart 表单：probe 是文本字段（可空串），file 是 0..4 个部件。 */
function probeForm(probe: string, files: File[]): FormData {
  const form = new FormData();
  form.append('probe', probe);
  for (const f of files) form.append('file', f, f.name || '样例图');
  return form;
}

export { PAGE_LIMIT };

