import { useMemo, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
auditExportUrl,
banUser,
createTitle,
deleteMailAccount,
fetchAnnouncements,
fetchAuditLogs,
fetchBanners,
fetchDomains,
fetchDonationStats,
fetchDonations,
fetchMailAccounts,
fetchNoticeDefaults,
fetchPermissions,
fetchReports,
fetchReviewQueue,
fetchRoles,
fetchSiteSettings,
fetchTitles,
fetchUsers,
grantTitle,
handleReport,
handleReportsBatch,
replaceRolePerms,
reviewTopic,
revokeUserSessions,
saveNoticeDefaults,
saveSiteSettings,
setUserRole,
testMailAccount,
updateAnnouncement,
updateBanner,
updateMailAccount,
updateTitle,
verifyDonation,
verifyDonationsBatch,
} from '@/lib/api/admin';
import type { AdminUserFilter, BatchItem, ReviewQueueItem } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { BASE } from '@/lib/base';
import { Empty } from '@/routes/_parts/state';
import { ReportsScreen, type ReportFilter } from '@/devroom/pages/15-admin/screens/reports';
import { RewardsScreen, type RewardsFilter } from '@/devroom/pages/15-admin/screens/rewards';
import { AuditScreen, ESCALATION_ACTIONS, type AuditFilter } from '@/devroom/pages/15-admin/screens/audit';
import { RolesScreen } from '@/devroom/pages/15-admin/screens/roles';
import { MailScreen } from '@/devroom/pages/15-admin/screens/mail';
import { SettingsScreen } from '@/devroom/pages/15-admin/screens/settings';
import { TitlesScreen } from '@/devroom/pages/15-admin/screens/titles';
import { ReviewScreen, type ReviewFilter } from '@/devroom/pages/15-admin/screens/review';
import { UsersScreen, type UsersFilter } from '@/devroom/pages/15-admin/screens/users';

// 后台各屏的**取数容器**（宿主）：把 /admin/* 的查询与动作变成屏的 props。
//
// 为什么单独一个文件、而不是把查询写进 routes/admin.tsx：
//   ① 体量（gate:size ≤ 500 行）；② 这里的东西每接一屏涨一截，而 admin.tsx 的布局不该跟着涨。
//
// 规矩：一个屏一个容器，容器里只做「取数 + 调用 + 回执」，屏里只摆版式（照 topic-view 的分工）。
// 容器与屏都在（而不是在 admin.tsx 里 switch）：**hooks 不能条件渲染**，而 useQuery 的 enabled
// 只能按屏开 —— 写成「一个组件里十个 useQuery」会让「打开用户屏」顺手打 8 个不相干的请求。

/** 容器把任何失败翻成一句人话（不吞错误，也不把 500 说成「没有数据」）。
 *  **不带状态码**：屏上的模板已经在写「（HTTP 404）」，带上就成了「HTTP 404 HTTP 404 接口不存在」。 */
export function errorLine(e: unknown): string | null {
  if (!e) return null;
  if (isApiError(e)) return e.message + (e.requestId ? '（编号 ' + e.requestId + '）' : '');
  return String(e);
}

/** 这一屏要用的端点还没有时的统一说法（**不拿示例数据兜底**：那样看起来像已经接完了）。 */
function MissingEndpoint({ perm, what, endpoints }: { perm: string; what: string; endpoints: string[] }) {
  return (
    <Empty
      title={what + '还没有可以对接的端点'}
      hint={
        '这一屏已经改成 prop 驱动、权限点也按真实 perms 判（' + perm + '），但后端还缺：' +
        endpoints.join('、') + '。在这一条落地前它不会拿示例数据兜底 —— ' +
        '「界面看着正常、其实什么都没发生」正是本仓库要消灭的形态。'
      }
    />
  );
}

// ── 屏 a：用户管理 ────────────────────────────────────────────────────────
// 依赖 GET /admin/users（交接单 C1，W-D1 在补）+ 已实装的 /admin/roles、/admin/titles 与四个动作端点。

export function UsersScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<UsersFilter>({ q: '', status: 'all', role: 'all' });
  const [receipt, setReceipt] = useState<string | null>(null);

  // 三根状态轴在 wire 上是两个独立布尔（auth/pgsql/admin_users.go 的 AdminUsersFilter）——
  // **不能合成一个 status 参数**：待激活与未验证是两根轴，合成后筛「未验证」会漏掉已激活的。
  const apiFilter: AdminUserFilter = useMemo(() => ({
    q: filter.q.trim() || undefined,
    status: filter.status === 'banned' ? 'banned' : undefined,
    activated: filter.status === 'pending_act' ? 'false' : filter.status === 'normal' ? 'true' : undefined,
    email_verified: filter.status === 'unverified' ? 'false' : undefined,
    role: filter.role === 'all' ? undefined : filter.role,
  }), [filter]);

  const users = useQuery({ queryKey: qk.adminUsers(apiFilter), queryFn: ({ signal }) => fetchUsers(apiFilter, signal) });
  const roles = useQuery({ queryKey: qk.adminRoles(), queryFn: ({ signal }) => fetchRoles(signal) });
  const titles = useQuery({ queryKey: qk.adminTitles(), queryFn: ({ signal }) => fetchTitles(signal) });

  const done = (msg: string) => { setReceipt(msg); void qc.invalidateQueries({ queryKey: ['admin'] }); };
  const ban = useMutation({
    mutationFn: async (v: { ids: string[]; action: 'ban' | 'unban'; reason: string }) => {
      // 逐条调用：后端**没有**批量用户端点（交接单 C6），所以这里如实逐条发，并把成功条数报回去。
      let ok = 0; const failed: string[] = [];
      for (const id of v.ids) {
        try { await banUser(id, v.action, v.reason); ok++; } catch (e) { failed.push(id + '：' + (errorLine(e) ?? '')); }
      }
      return { ok, failed };
    },
    onSuccess: (r) => done(r.failed.length === 0
      ? '已处理 ' + r.ok + ' 个用户'
      : '成功 ' + r.ok + ' 个，失败 ' + r.failed.length + ' 个：' + r.failed.slice(0, 3).join('；')),
    onError: (e) => setReceipt('操作失败：' + errorLine(e)),
  });
  const revoke = useMutation({
    mutationFn: revokeUserSessions,
    onSuccess: (r) => done('已踢掉 ' + r.revoked + ' 个会话'),
    onError: (e) => setReceipt('踢会话失败：' + errorLine(e)),
  });
  const role = useMutation({
    mutationFn: (v: { id: string; roleId: number }) => setUserRole(v.id, v.roleId),
    onSuccess: () => done('基线角色已改（角色之间永不并集，这是替换）'),
    onError: (e) => setReceipt('改角色失败：' + errorLine(e)),
  });
  const title = useMutation({
    mutationFn: (v: { userId: string; titleId: string }) => grantTitle(v.userId, v.titleId),
    onSuccess: () => done('头衔已授予'),
    onError: (e) => setReceipt('发头衔失败：' + errorLine(e)),
  });

  const me = session.session;
  const receiptNode = receipt ? (
    <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
  ) : null;

  return (
    <UsersScreen
      users={users.data?.items ?? []}
      total={users.data?.items.length ?? 0}
      loading={users.isPending}
      error={users.error ? { message: errorLine(users.error) ?? '', status: isApiError(users.error) ? users.error.status : 0 } : null}
      filter={filter}
      onFilterChange={setFilter}
      roles={roles.data ?? []}
      titles={titles.data ?? []}
      canBan={can(me, 'user.ban')}
      canAssignRole={can(me, 'role.assign')}
      canGrantTitle={can(me, 'title.grant')}
      onBan={(ids, action, reason) => ban.mutate({ ids, action, reason })}
      onRevokeSessions={(id) => revoke.mutate(id)}
      onSetRole={(id, roleId) => role.mutate({ id, roleId })}
      onGrantTitle={(userId, titleId) => title.mutate({ userId, titleId })}
      receipt={receiptNode}
    />
  );
}


// ── 屏 d：帖子审核队列 ────────────────────────────────────────────────────
// 依赖 GET /admin/topics（队列）与 POST /admin/topics/{id}/review（判定）——**两条都已在**。
// 游标分页：cursor 是宿主的本地状态（后端给 next_cursor，前端只回传不解释，拍板 §5.6）。

export function ReviewScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<ReviewFilter>({ state: 'pending', board: 'all', q: '' });
  // 游标栈：改筛选就清空（换了筛选条件，旧游标指向的位置没有意义）
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  // cursor 进 key 也进 query：换一页是另一次查询（key 里不带 cursor 会让每页互相覆盖）
  const apiFilter = useMemo(() => ({
    state: filter.state,
    board: filter.board === 'all' ? undefined : filter.board,
    q: filter.q.trim() || undefined,
    cursor,
  }), [filter, cursor]);

  const queue = useQuery({
    queryKey: qk.adminReview(apiFilter),
    queryFn: ({ signal }) => fetchReviewQueue(apiFilter, signal),
  });

  const decide = useMutation({
    mutationFn: (v: { item: ReviewQueueItem; action: 'approve' | 'reject'; note: string }) =>
      reviewTopic(v.item.id, v.action, v.note, v.item.updated_at),
    onSuccess: (updated, v) => {
      setReceipt('已' + (v.action === 'approve' ? '通过' : '拒绝') + '「' + updated.title + '」');
      void qc.invalidateQueries({ queryKey: ['admin', 'review'] });
    },
    // 版本冲突（作者改了正文 / 别人判过）是**预期内的 400**，不是崩溃：如实说出来让人刷新。
    onError: (e) => setReceipt('判定失败：' + (errorLine(e) ?? '')),
  });

  const me = session.session;
  return (
    <ReviewScreen
      items={queue.data?.items ?? []}
      hasMore={Boolean(queue.data?.next)}
      loading={queue.isPending}
      error={queue.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          队列没能加载（HTTP {isApiError(queue.error) ? queue.error.status : 0}）：{errorLine(queue.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); }}
      onLoadMore={() => { if (queue.data?.next) setCursors((c) => [...c, queue.data!.next]); }}
      canReview={can(me, 'post.review')}
      onReview={(item, action, note) => decide.mutate({ item, action, note })}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}


// ── 屏 e：举报处理队列 ────────────────────────────────────────────────────
// 依赖 GET /admin/reports、PATCH /admin/reports/{id}、POST /admin/reports/batch（三条都已在）。
// 批量**逐条成败**：后端一个事务 + 逐条 CAS，所以把 results 原样交给屏，不做「全成功」的假设。

export function ReportsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<ReportFilter>({ state: 'open', target_type: 'all' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<BatchItem[] | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  const apiFilter = useMemo(() => ({
    state: filter.state,
    target_type: filter.target_type === 'all' ? undefined : filter.target_type,
    cursor,
  }), [filter, cursor]);

  const queue = useQuery({
    queryKey: qk.adminReports(apiFilter),
    queryFn: ({ signal }) => fetchReports(apiFilter, signal),
  });

  const act = useMutation({
    mutationFn: (v: { ids: string[]; state: 'handled' | 'dismissed'; note: string }) =>
      v.ids.length === 1
        ? handleReport(v.ids[0]!, v.state, v.note).then(() => ({ results: null as BatchItem[] | null }))
        : handleReportsBatch(v.ids, v.state, v.note).then((r) => ({ results: r.results })),
    onSuccess: (r, v) => {
      setBatchResults(r.results);
      setReceipt(r.results === null
        ? '已' + (v.state === 'handled' ? '标记为已处理' : '驳回') + ' 1 条举报'
        : (r.results.every((x) => x.ok) ? '批量处理 ' + r.results.length + ' 条，全部成功' : null));
      void qc.invalidateQueries({ queryKey: ['admin', 'reports'] });
    },
    onError: (e) => { setBatchResults(null); setReceipt('处理失败：' + (errorLine(e) ?? '')); },
  });

  const me = session.session;
  return (
    <ReportsScreen
      items={queue.data?.items ?? []}
      hasMore={Boolean(queue.data?.next)}
      loading={queue.isPending}
      error={queue.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          举报队列没能加载（HTTP {isApiError(queue.error) ? queue.error.status : 0}）：{errorLine(queue.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); setBatchResults(null); }}
      onLoadMore={() => { if (queue.data?.next) setCursors((c) => [...c, queue.data!.next]); }}
      canHandle={can(me, 'report.handle')}
      onHandle={(ids, state, note) => act.mutate({ ids, state, note })}
      batchResults={batchResults}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}


// ── 屏 f：打赏核验队列 ────────────────────────────────────────────────────
// 依赖 GET /admin/rewards、POST /admin/rewards/{id}/verify、POST /admin/rewards/batch、
// GET /admin/rewards/stats、GET/PATCH /admin/donation-notice-defaults —— **五条都已在**。

export function RewardsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<RewardsFilter>({ state: 'pending' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<BatchItem[] | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  const queue = useQuery({
    queryKey: qk.adminRewards({ state: filter.state, cursor }),
    queryFn: ({ signal }) => fetchDonations({ state: filter.state, cursor }, signal),
  });
  const stats = useQuery({ queryKey: qk.adminRewardStats(), queryFn: ({ signal }) => fetchDonationStats(10, signal) });
  const notices = useQuery({ queryKey: qk.adminNoticeDefaults(), queryFn: ({ signal }) => fetchNoticeDefaults(signal) });

  const act = useMutation({
    mutationFn: (v: { ids: string[]; state: 'approved' | 'rejected'; note: string }) =>
      v.ids.length === 1
        ? verifyDonation(v.ids[0]!, v.state, v.note).then(() => ({ results: null as BatchItem[] | null }))
        : verifyDonationsBatch(v.ids, v.state, v.note).then((r) => ({ results: r.results })),
    onSuccess: (r, v) => {
      setBatchResults(r.results);
      setReceipt(r.results === null
        ? '已' + (v.state === 'approved' ? '核验通过' : '拒绝') + ' 1 笔'
        : (r.results.every((x) => x.ok) ? '批量核验 ' + r.results.length + ' 笔，全部成功' : null));
      void qc.invalidateQueries({ queryKey: ['admin', 'rewards'] });
    },
    onError: (e) => { setBatchResults(null); setReceipt('核验失败：' + (errorLine(e) ?? '')); },
  });
  const saveNotices = useMutation({
    mutationFn: saveNoticeDefaults,
    onSuccess: () => { setReceipt('渠道默认文案已整表替换'); void qc.invalidateQueries({ queryKey: qk.adminNoticeDefaults() }); },
    onError: (e) => setReceipt('保存文案失败：' + (errorLine(e) ?? '')),
  });

  const me = session.session;
  return (
    <RewardsScreen
      items={queue.data?.items ?? []}
      hasMore={Boolean(queue.data?.next)}
      loading={queue.isPending}
      error={queue.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          核验队列没能加载（HTTP {isApiError(queue.error) ? queue.error.status : 0}）：{errorLine(queue.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); setBatchResults(null); }}
      onLoadMore={() => { if (queue.data?.next) setCursors((c) => [...c, queue.data!.next]); }}
      stats={stats.data ?? null}
      noticeDefaults={notices.data ?? []}
      onSaveNoticeDefaults={(items) => saveNotices.mutate(items)}
      canVerify={can(me, 'reward.verify')}
      canSiteSetting={can(me, 'site.setting')}
      onVerify={(ids, state, note) => act.mutate({ ids, state, note })}
      batchResults={batchResults}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}


// ── 屏 g：头衔目录 ────────────────────────────────────────────────────────
// 依赖 GET/POST /admin/titles 与 PATCH /admin/titles/{id}（三条都已在，权限点 title.manage）。

export function TitlesScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const list = useQuery({ queryKey: qk.adminTitles(), queryFn: ({ signal }) => fetchTitles(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.adminTitles() });
  // PATCH 的 body 是**全字段**（title/handler.go 的 titleBody），所以改一个字段也要把其余原样带上。
  const create = useMutation({
    mutationFn: createTitle,
    onSuccess: (t) => { setReceipt('已新建头衔「' + t.name + '」'); refresh(); },
    onError: (e) => setReceipt('新建失败：' + (errorLine(e) ?? '')),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; body: { key: string; name: string; color: string; description: string; archived: boolean } }) =>
      updateTitle(v.id, v.body),
    onSuccess: (t) => { setReceipt('已保存「' + t.name + '」' + (t.archived_at ? '（已归档）' : '')); refresh(); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });

  return (
    <TitlesScreen
      titles={list.data ?? []}
      loading={list.isPending}
      error={list.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          头衔目录没能加载（HTTP {isApiError(list.error) ? list.error.status : 0}）：{errorLine(list.error)}
        </p>
      ) : null}
      canManage={can(session.session, 'title.manage')}
      onCreate={(b) => create.mutate(b)}
      onUpdate={(id, body) => update.mutate({ id, body })}
      busy={create.isPending || update.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}


// ── 屏 h：发信账号 ────────────────────────────────────────────────────────
// 依赖 GET/POST/PATCH/DELETE /admin/mail/accounts 与 POST /admin/mail/accounts/{id}/test（都已在）。

export function MailScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const list = useQuery({ queryKey: qk.adminMail(), queryFn: ({ signal }) => fetchMailAccounts(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.adminMail() });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Parameters<typeof updateMailAccount>[1] }) => updateMailAccount(v.id, v.body),
    onSuccess: (a, v) => { setReceipt('已保存「' + a.name + '」的 ' + Object.keys(v.body).join('、')); refresh(); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });
  const remove = useMutation({
    mutationFn: deleteMailAccount,
    onSuccess: (r) => { setReceipt(r.archived ? '账号已归档' : '账号已删除'); refresh(); },
    onError: (e) => setReceipt('删除失败：' + (errorLine(e) ?? '')),
  });
  const test = useMutation({
    mutationFn: (v: { id: string; to: string }) => testMailAccount(v.id, v.to),
    onSuccess: (r) => { setReceipt('已入队一封测试信（mail_log_id=' + r.mail_log_id + '）——「入队成功」不等于「对方收到了」，去 mail_logs 看结果'); refresh(); },
    onError: (e) => setReceipt('测试发信失败：' + (errorLine(e) ?? '')),
  });

  return (
    <MailScreen
      accounts={list.data ?? []}
      loading={list.isPending}
      error={list.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          发信账号没能加载（HTTP {isApiError(list.error) ? list.error.status : 0}）：{errorLine(list.error)}
        </p>
      ) : null}
      canManage={can(session.session, 'mail.manage')}
      onPatch={(id, body) => patch.mutate({ id, body })}
      onDelete={(id) => remove.mutate(id)}
      onTest={(id, to) => test.mutate({ id, to })}
      busy={patch.isPending || remove.isPending || test.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}


// ── 屏 i：站点设置 ────────────────────────────────────────────────────────
// 依赖 GET/PATCH /admin/site-settings、GET /admin/site-domains、
// GET/POST /admin/announcements + PATCH、GET/POST /admin/banners + PATCH（都已在，权限点 site.setting）。
// 键值目录由后端给（SettingItem），前端不维护第二张表。

export function SettingsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const settings = useQuery({ queryKey: qk.adminSiteSettings(), queryFn: ({ signal }) => fetchSiteSettings(signal) });
  const domains = useQuery({ queryKey: qk.adminDomains(), queryFn: ({ signal }) => fetchDomains(signal) });
  const announcements = useQuery({ queryKey: qk.adminAnnouncements(), queryFn: ({ signal }) => fetchAnnouncements(signal) });
  const banners = useQuery({ queryKey: qk.adminBanners(), queryFn: ({ signal }) => fetchBanners(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin'] });

  const save = useMutation({
    mutationFn: saveSiteSettings,
    onSuccess: () => { setReceipt('设置已保存（只写了改动过的键）'); refresh(); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });
  const toggleAnn = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => updateAnnouncement(v.id, { enabled: v.enabled }),
    onSuccess: (a) => { setReceipt('公告「' + a.title + '」已' + (a.enabled ? '启用' : '停用')); refresh(); },
    onError: (e) => setReceipt('公告改动失败：' + (errorLine(e) ?? '')),
  });
  const publishAnn = useMutation({
    mutationFn: (id: string) => updateAnnouncement(id, { publish: true }),
    onSuccess: (a) => { setReceipt('公告「' + a.title + '」已发布'); refresh(); },
    onError: (e) => setReceipt('发布失败：' + (errorLine(e) ?? '')),
  });
  const toggleBanner = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => updateBanner(v.id, { enabled: v.enabled }),
    onSuccess: (b) => { setReceipt('横幅已' + (b.enabled ? '启用' : '停用')); refresh(); },
    onError: (e) => setReceipt('横幅改动失败：' + (errorLine(e) ?? '')),
  });

  const err = [settings.error, domains.error, announcements.error, banners.error].find(Boolean);
  return (
    <SettingsScreen
      settings={settings.data ?? []}
      domains={domains.data ?? []}
      announcements={announcements.data ?? []}
      banners={banners.data ?? []}
      loading={settings.isPending}
      error={err ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          设置没能加载（HTTP {isApiError(err) ? err.status : 0}）：{errorLine(err)}
        </p>
      ) : null}
      canSetting={can(session.session, 'site.setting')}
      onSave={(values) => save.mutate(values)}
      onToggleAnnouncement={(id, enabled) => toggleAnn.mutate({ id, enabled })}
      onPublishAnnouncement={(id) => publishAnn.mutate(id)}
      onToggleBanner={(id, enabled) => toggleBanner.mutate({ id, enabled })}
      busy={save.isPending || toggleAnn.isPending || publishAnn.isPending || toggleBanner.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}


// ── 屏 j：审计日志 ────────────────────────────────────────────────────────
// 依赖 GET /admin/audit-logs（筛选齐全）与 GET /admin/audit-logs/export（csv）。
// 导出走 <a href> 直下文件，不经 fetch（前端方案 §5 的 fetch 唯一出口管不到浏览器下载）。

export function AuditScreenContainer() {
  const session = useSession();
  const [filter, setFilter] = useState<AuditFilter>({ collector: 'all', target_type: 'all', action: 'all', keyword: '', from: '', to: '' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  // 「只看提权类」不是后端的一个参数（它是**多个动作**），所以那两档在前端落到屏上筛本页；
  // 其余三档（操作者 / 目标类型 / 具体动作）后端都收，直接进 query。
  const apiFilter = useMemo(() => ({
    actor: filter.collector === 'all' || filter.collector === 'system' ? undefined : filter.collector,
    target_type: filter.target_type === 'all' ? undefined : filter.target_type,
    action: filter.action === 'all' || filter.action === 'escalation' ? undefined : filter.action,
    target_id: filter.keyword.trim() || undefined,
    from: filter.from.trim() || undefined,
    to: filter.to.trim() || undefined,
    cursor,
  }), [filter, cursor]);

  const logs = useQuery({
    queryKey: qk.adminAudit(apiFilter),
    queryFn: ({ signal }) => fetchAuditLogs(apiFilter, signal),
  });

  const me = session.session;
  const rows = (logs.data?.items ?? []).filter((l) => {
    if (filter.collector === 'system' && l.actor) return false;
    if (filter.action === 'escalation' && !ESCALATION_ACTIONS.includes(l.action)) return false;
    return true;
  });

  return (
    <AuditScreen
      items={rows}
      hasMore={Boolean(logs.data?.next)}
      loading={logs.isPending}
      error={logs.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          审计日志没能加载（HTTP {isApiError(logs.error) ? logs.error.status : 0}）：{errorLine(logs.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); }}
      onLoadMore={() => { if (logs.data?.next) setCursors((c) => [...c, logs.data!.next]); }}
      canView={can(me, 'audit.view')}
      canExport={can(me, 'audit.export')}
      exportHref={auditExportUrl(BASE, {
        target_type: apiFilter.target_type, action: apiFilter.action, actor: apiFilter.actor,
        from: apiFilter.from, to: apiFilter.to, target_id: apiFilter.target_id,
      })}
    />
  );
}


// ── 屏 b：角色 × 权限矩阵 ──────────────────────────────────────────────────
// 依赖 GET /admin/roles、GET /admin/permissions、PATCH /admin/roles/{id}/permissions（都已在）。
// **没有「新建 / 删除角色」端点**（§5.2 只列了矩阵），所以屏上没有那两颗按钮。

export function RolesScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const roles = useQuery({ queryKey: qk.adminRoles(), queryFn: ({ signal }) => fetchRoles(signal) });
  const perms = useQuery({ queryKey: qk.adminPermissions(), queryFn: ({ signal }) => fetchPermissions(signal) });
  const save = useMutation({
    mutationFn: (v: { roleId: number; permKeys: string[] }) => replaceRolePerms(v.roleId, v.permKeys),
    onSuccess: (_r, v) => {
      setReceipt('矩阵已保存（全量替换，' + v.permKeys.length + ' 个权限点）');
      void qc.invalidateQueries({ queryKey: qk.adminRoles() });
    },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });

  const err = roles.error ?? perms.error;
  return (
    <RolesScreen
      roles={roles.data ?? []}
      permissions={perms.data ?? []}
      loading={roles.isPending || perms.isPending}
      error={err ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          角色或权限点目录没能加载（HTTP {isApiError(err) ? err.status : 0}）：{errorLine(err)}
        </p>
      ) : null}
      canEdit={can(session.session, 'role.edit')}
      onSave={(roleId, permKeys) => save.mutate({ roleId, permKeys })}
      busy={save.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

// 其余 11 屏的容器在下面逐屏加（一屏一个提交，见 完全重构/进行中/进度-W-D2.md 的顺序）。
// 没有容器的屏先不接：拿示例数据兜底会让「没接完」看起来像「接完了」。
const PENDING_SCREENS: Record<string, { perm: string; what: string; endpoints: string[] }> = {
  boards: { perm: 'board.manage', what: '分区管理', endpoints: ['GET /admin/boards', 'PUT /admin/boards/{id}/acl', 'POST /admin/boards/reorder'] },
  diagnostics: { perm: 'site.setting', what: '自检面板', endpoints: ['GET /admin/diagnostics'] },
};

/** 造一个「这一屏的端点还没到」的占位屏。工厂而不是组件：admin.tsx 的映射表要的是组件类型。 */
export function PendingScreen(key: string): ComponentType<Record<string, never>> {
  const p = PENDING_SCREENS[key];
  if (!p) throw new Error('PendingScreen: 没有登记 ' + key);
  const C = () => <MissingEndpoint perm={p.perm} what={p.what} endpoints={p.endpoints} />;
  C.displayName = 'PendingScreen_' + key;
  return C;
}
