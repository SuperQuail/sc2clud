import { useState } from 'react';
import type { MailTemplatePreview } from '@/lib/api/admin';
import { CURRENT_ADMIN } from './mock/perms';
import { DEMO_AI_CONFIG, DEMO_AI_PAYLOAD, DEMO_AI_TEST, DEMO_PERMISSIONS, DEMO_ANNOUNCEMENTS, DEMO_AUDIT, DEMO_BANNERS, DEMO_DOMAINS, DEMO_DONATIONS, DEMO_DONATION_STATS, DEMO_MAIL, DEMO_MAIL_TPL, DEMO_MAILTPL_BUILTIN, DEMO_MAILTPL_PREVIEW, DEMO_NOTICE_DEFAULTS, DEMO_REPORTS, DEMO_REVIEW, DEMO_ROLES, DEMO_SETTINGS, DEMO_TITLES, DEMO_USER_DETAIL, DEMO_USERS } from './mock/fixtures';
import { AdminShell, type AdminSelf } from './shell';
import { SCREEN_KEYS, type ScreenKey } from './nav';
import { ADMIN_ACLS, ADMIN_BOARDS, ADMIN_GROUP_ACLS, DEMO_GROUPS, DIAGNOSTICS_ROOM } from './room-data';
import { AiReviewScreen } from './screens/ai-review';
import { AuditScreen, type AuditFilter } from './screens/audit';
import { BoardsScreen, type BoardPatch } from './screens/boards';
import { GroupsScreen, type GroupsScreenProps } from './screens/groups';
import { DiagnosticsScreen } from './screens/diagnostics';
import { MailScreen } from './screens/mail';
import { MailTemplateScreen } from './screens/mail-tpl';
import { ReportsScreen, type ReportFilter } from './screens/reports';
import { ReviewScreen, type ReviewFilter } from './screens/review';
import { RewardsScreen, type RewardsFilter } from './screens/rewards';
import { RolesScreen } from './screens/roles';
import { SettingsScreen } from './screens/settings';
import { TitlesScreen } from './screens/titles';
import { UsersScreen, type UsersCounts, type UsersFilter } from './screens/users';

// DevRoom 15 · 管理后台（对照老站 13.1–13.15 与后端 §9.8 / §20.4 D6 / §21.2）。
// 对照表在 ./admin-map.md。
//
// **这一页是舞台，不是第二个实现**：屏改成 prop 驱动之后，房间与真站渲染同一批组件
//（真站的取数在 web/src/routes/admin-screens.tsx）。房间给本地演示数据与本地回执，
// 真站给 lib/api —— 与 12-topic 的分工逐字一致。
// 屏切换：真实实现是 /admin/<屏> 的路由 + 每屏声明权限点（前端方案 §6）；DevRoom 里用 ?screen= 初值 + 本地状态，
// 这样出图/评审能直接给到某一屏（「URL 即状态」的最小版本）。
const SCREENS: Record<ScreenKey, () => React.ReactNode> = {
  users: () => <UsersRoom />,
  roles: () => <RolesRoom />,
  groups: () => <GroupsRoom />,
  boards: () => <BoardsRoom />,
  review: () => <ReviewRoom />,
  reports: () => <ReportsRoom />,
  rewards: () => <RewardsRoom />,
  titles: () => <TitlesRoom />,
  mail: () => <MailRoom />,
  mailtpl: () => <MailTplRoom />,
  settings: () => <SettingsRoom />,
  ai: () => <AiRoom />,
  audit: () => <AuditRoom />,
  diagnostics: () => <DiagnosticsRoom />,
};

/** 分区管理屏的房间版（数据在 ./room-data）。 */
function BoardsRoom() {
  const [boards, setBoards] = useState(ADMIN_BOARDS);
  const [boardId, setBoardId] = useState<string | null>(ADMIN_BOARDS[0]?.id ?? null);
  const [savedAt, setSavedAt] = useState(0);
  const [receipt, setReceipt] = useState<string | null>(null);
  const say = (msg: string) => setReceipt('（房间演示：这里不发请求）' + msg);
  const board = boards.find((b) => b.id === boardId) ?? boards[0] ?? null;
  const id = board?.id ?? '';
  return (
    <BoardsScreen
      key={id}
      boards={boards}
      boardId={board?.id ?? null}
      onSelect={(next) => { setBoardId(next); setReceipt(null); }}
      savedAt={savedAt}
      onSave={(patch: Partial<BoardPatch>) => {
        setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } as typeof b : b)));
        setSavedAt((n) => n + 1);
        say('已保存 ' + Object.keys(patch).join('、'));
      }}
      onMove={(next) => { setBoards((prev) => next.map((x) => prev.find((b) => b.id === x)!)); say('顺序已保存（' + next.length + ' 个分区，全量顺序）'); }}
      roles={DEMO_ROLES}
      acl={ADMIN_ACLS[id] ?? []}
      onAclSave={(acls) => say('名单已保存（全量替换：' + acls.length + ' 行）')}
      groups={DEMO_GROUPS}
      groupAcl={ADMIN_GROUP_ACLS[id] ?? []}
      onGroupAclSave={(acls) => say('按组名单已保存（全量替换：' + acls.length + ' 行）')}
      moderators={board ? board.moderators.map((m, i) => ({ ...m, grown_at: i === board.moderators.length - 1 && board.moderators.length > 1 ? '2026-08-01T00:00:00Z' : null })) : []}
      candidates={DEMO_USERS.slice(0, 6).map((u) => ({ id: u.id, username: u.username, nickname: u.nickname }))}
      onGrantModerator={(userId) => say('任命 ' + userId + ' 为版主')}
      onRevokeModerator={(userId) => say('免掉 ' + userId)}
      onCreate={(b) => { say('新建分区 /' + b.slug + '（slug 建后不可改）'); setBoards((prev) => [...prev, { ...ADMIN_BOARDS[0]!, id: 'b-new', slug: b.slug, name: b.name, description: b.description, topic_count: 0, post_count: 0, today_count: 0, moderators: [] }]); }}
      onSetStatus={(status, reason) => { setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b))); say('状态改成 ' + status + (reason ? '（说明：' + reason + '）' : '')); }}
      canManage
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 用户组屏的房间版（D38）：目录来自 ./room-data 的演示组，动作只留一条回执（房间不发请求）。 */
function GroupsRoom() {
  const [groups, setGroups] = useState<GroupsScreenProps['groups']>(DEMO_GROUPS);
  const [groupId, setGroupId] = useState<string | null>(DEMO_GROUPS[0]?.id ?? null);
  const [members, setMembers] = useState<GroupsScreenProps['members']>([
    { user_id: 'u1', handle: 'demo-admin', nickname: '示范管理员', added_at: '2026-09-01T02:00:00Z' },
    { user_id: 'u6', handle: 'demo-lead', nickname: '地图工坊主', added_at: '2026-09-14T02:00:00Z' },
  ]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const say = (msg: string) => setReceipt('（房间演示：这里不发请求）' + msg);
  return (
    <GroupsScreen
      key={groupId}
      groups={groups}
      groupId={groupId}
      onSelect={(next) => { setGroupId(next); setReceipt(null); }}
      onCreate={(b) => {
        const g = { id: 'g-new-' + (groups.length + 1), key: b.key, name: b.name, description: b.description, member_count: 0, created_at: '2026-10-15T04:00:00Z', updated_at: '2026-10-15T04:00:00Z' };
        setGroups((prev) => [...prev, g]);
        setGroupId(g.id);
        say('已建组「' + b.name + '」（key=' + b.key + '，建后不可改）');
      }}
      onSave={(gid, patch) => {
        setGroups((prev) => prev.map((g) => (g.id === gid ? { ...g, ...patch } : g)));
        say('已保存组资料（' + Object.keys(patch).join('、') + '）');
      }}
      onDelete={(gid) => {
        setGroups((prev) => prev.filter((g) => g.id !== gid));
        say('已删除该组（成员与按组授权行同时清空）');
      }}
      members={members}
      candidates={DEMO_USERS.slice(0, 6).map((u) => ({ id: u.id, username: u.username, nickname: u.nickname }))}
      onAddMember={(userId) => {
        const u = DEMO_USERS.find((x) => x.id === userId);
        if (u) setMembers((prev) => [{ user_id: u.id, handle: u.username, nickname: u.nickname, added_at: '2026-10-15T04:00:00Z' }, ...prev]);
        say('已拉「' + (u?.nickname ?? userId) + '」入组（判定当场生效）');
      }}
      onRemoveMember={(userId) => {
        setMembers((prev) => prev.filter((m) => m.user_id !== userId));
        say('已移出该成员（按组授予的资格立刻失效）');
      }}
      canManage

      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 自检面板的房间版（只读屏，给一份本地结果）。 */
function DiagnosticsRoom() {
  return <DiagnosticsScreen data={DIAGNOSTICS_ROOM} canSetting />;
}

/** AI 审核屏的房间版。
 *  **payload 预览在房间里是静态的**：真站那两块由 POST /admin/ai/payload 组装（dry-run 不外呼），
 *  房间没有后端，所以给一份「那条端点会回什么」的投影（DEMO_AI_PAYLOAD）—— 与真站渲染**同一个组件**。
 *  样例编辑器在房间里照常可改（受控 state），只是预览不会跟着重算：房里的预览不是服务端算的那一份。 */
function AiRoom() {
  const [cfg, setCfg] = useState(DEMO_AI_CONFIG);
  const [test, setTest] = useState(DEMO_AI_TEST);
  const [probe, setProbe] = useState(DEMO_AI_CONFIG.probe_sample);
  const [sampleFiles, setSampleFiles] = useState<File[]>([]);
  const [receipt, setReceipt] = useState<string | null>(null);
  return (
    <AiReviewScreen
      config={cfg}
      canSetting
      probe={probe}
      defaultProbe={DEMO_AI_CONFIG.probe_sample}
      onProbeChange={(next) => { setProbe(next); setReceipt('（房间演示：这里不发请求）样例已临时改动，只影响这一次测试'); }}
      sampleFiles={sampleFiles}
      onSampleFilesChange={(next) => { setSampleFiles(next); setReceipt('（房间演示：这里不发请求）样例图改成了 ' + next.length + ' 张 —— 真站的干跑会跟着重算并回逐张下场'); }}
      payload={DEMO_AI_PAYLOAD}
      onPatch={(p) => { setCfg((c) => ({ ...c, ...p })); setReceipt('（房间演示：这里不发请求）已保存 ' + Object.keys(p).join('、')); }}
      onSaveSecret={() => { setCfg((c) => ({ ...c, has_secret: true, secret_updated_at: new Date().toISOString() })); setReceipt('（房间演示：这里不发请求）密钥已保存（只写不回显）'); }}
      onTest={() => {
        // 房间不发请求：receipt 是「这条端点会回什么」的投影（D33③ 同款）。带了样例图（D34）就
        // 按 TestSample 回执的形状投出「判了几张 / 逐张下场」—— 图元不在房间里，hash 用文件名。
        setTest(sampleFiles.length > 0 ? {
          ...DEMO_AI_TEST,
          image_count: sampleFiles.length,
          image_skipped: 0,
          images: sampleFiles.map((f, i) => ({ position: i, floor: 0, hash: f.name, mime: f.type || 'image/png', bytes: f.size, sent: true, note: '' })),
        } : DEMO_AI_TEST);
        setReceipt(null);
      }}
      testResult={test}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 角色矩阵屏的房间版。 */
function RolesRoom() {
  const [roles, setRoles] = useState(DEMO_ROLES);
  const [receipt, setReceipt] = useState<string | null>(null);
  return (
    <RolesScreen
      roles={roles}
      permissions={DEMO_PERMISSIONS}
      canEdit
      onSave={(roleId, permKeys) => { setRoles((p) => p.map((r) => (r.id === roleId ? { ...r, perm_keys: permKeys } : r))); setReceipt('（房间演示：这里不发请求）矩阵已保存，' + permKeys.length + ' 个权限点'); }}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 审计屏的房间版。 */
function AuditRoom() {
  const [filter, setFilter] = useState<AuditFilter>({ collector: 'all', target_type: 'all', action: 'all', keyword: '', from: '', to: '' });
  return (
    <AuditScreen
      items={DEMO_AUDIT}
      hasMore={false}
      filter={filter}
      onFilterChange={setFilter}
      canView
      canExport
    />
  );
}

/** 站点设置屏的房间版。 */
function SettingsRoom() {
  const [settings, setSettings] = useState(DEMO_SETTINGS);
  const [announcements, setAnnouncements] = useState(DEMO_ANNOUNCEMENTS);
  const [banners, setBanners] = useState(DEMO_BANNERS);
  const [receipt, setReceipt] = useState<string | null>(null);
  return (
    <SettingsScreen
      settings={settings}
      domains={DEMO_DOMAINS}
      announcements={announcements}
      banners={banners}
      canSetting
      onSave={(values) => { setSettings((p) => p.map((s) => (values[s.key] !== undefined ? { ...s, value: values[s.key]! } : s))); setReceipt('（房间演示：这里不发请求）已保存 ' + Object.keys(values).join('、')); }}
      onToggleAnnouncement={(id, enabled) => setAnnouncements((p) => p.map((a) => (a.id === id ? { ...a, enabled } : a)))}
      onPublishAnnouncement={(id) => setAnnouncements((p) => p.map((a) => (a.id === id ? { ...a, published_at: '2026-10-12T13:45:00Z' } : a)))}
      onToggleBanner={(id, enabled) => setBanners((p) => p.map((b) => (b.id === id ? { ...b, enabled } : b)))}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 发信账号屏的房间版。 */
function MailRoom() {
  const [accounts, setAccounts] = useState(DEMO_MAIL);
  const [receipt, setReceipt] = useState<string | null>(null);
  return (
    <MailScreen
      accounts={accounts}
      canManage
      onCreate={(body) => {
        const next = {
          ...body,
          id: 'ma-' + (accounts.length + 1),
          sent_today: 0,
          status: 'active',
          secret_configured: body.secret !== undefined,
          secret_updated_at: body.secret !== undefined ? '2026-10-15T02:00:00Z' : null,
          last_ok_at: null, last_error: '', last_error_at: null,
          created_at: '2026-10-15T02:00:00Z', updated_at: '2026-10-15T02:00:00Z',
          reset_tz: body.reset_tz ?? 'Asia/Shanghai',
          from_name: body.from_name ?? '', priority: body.priority ?? 0, daily_limit: body.daily_limit ?? 100,
          enabled: body.enabled ?? true, options_json: body.options_json ?? {},
        } as (typeof DEMO_MAIL)[number];
        setAccounts((prev) => [...prev, next]);
        setReceipt('（房间演示：这里不发请求）已新建账号「' + next.name + '」');
      }}
      onPatch={(id, p) => { setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } : a))); setReceipt('（房间演示：这里不发请求）已保存 ' + Object.keys(p).join('、')); }}
      onSecret={(id, p) => { setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, secret_configured: true, secret_updated_at: '2026-10-15T02:00:00Z' } : a))); setReceipt('（房间演示：这里不发请求）已换凭据 ' + Object.keys(p).join('、')); }}
      onDelete={(id) => { setAccounts((prev) => prev.filter((a) => a.id !== id)); setReceipt('（房间演示：这里不发请求）账号已删除'); }}
      onTest={(id, to) => setReceipt('（房间演示：这里不发请求）给 ' + to + ' 发一封测试信（账号 ' + id + '）')}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}


/** 邮件模板屏的房间版（D37）：四行 + 「这条端点会回什么」的投影预览，动作只留回执。 */
function MailTplRoom() {
  const [templates, setTemplates] = useState(DEMO_MAIL_TPL);
  const [preview, setPreview] = useState<MailTemplatePreview | null>(DEMO_MAILTPL_PREVIEW);
  const [receipt, setReceipt] = useState<string | null>(null);
  const say = (msg: string) => setReceipt('（房间演示：这里不发请求）' + msg);
  return (
    <MailTemplateScreen
      templates={templates}
      canManage
      preview={preview}
      onSave={(_kind, body) => {
        setTemplates((prev) => prev.map((t) => (t.kind === _kind ? { ...t, custom: true, ...body, updated_at: '2026-10-15T12:30:00Z', updated_by: 4 } : t)));
        setPreview(null);
        say('已保存三段模板源（真站：PUT /admin/mail-templates/' + _kind + '，保存前双模板编译校验）');
      }}
      onReset={(kind) => {
        const b = DEMO_MAILTPL_BUILTIN[kind];
        setTemplates((prev) => prev.map((t) => (t.kind === kind && b ? { ...t, ...b, custom: false, updated_at: null, updated_by: null } : t)));
        setPreview(null);
        say('已恢复内置（真站：DELETE，下一次渲染落回 embed；编辑框回显的是内置三段源）');
      }}
      onPreview={(_kind, body) => {
        setPreview({
          ...DEMO_MAILTPL_PREVIEW,
          subject: (body.subject ?? DEMO_MAILTPL_PREVIEW.subject),
        });
        setReceipt('（房间演示：这里不发请求）用还没保存的那份渲染 —— 真站会按站点设置取站名、样本昵称带 <script>');
      }}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 头衔目录屏的房间版。 */
function TitlesRoom() {
  const [titles, setTitles] = useState(DEMO_TITLES);
  const [receipt, setReceipt] = useState<string | null>(null);
  return (
    <TitlesScreen
      titles={titles}
      canManage
      onCreate={async (b) => {
        setTitles((p) => [...p, { id: 't-' + (p.length + 1), ...b, archived_at: null }]);
        setReceipt('（房间演示：这里不发请求）已新建「' + b.name + '」');
        return true; // 房间里必成功：真页面的成败由后端回执决定
      }}
      onUpdate={(id, b) => { setTitles((p) => p.map((t) => (t.id === id ? { ...t, ...b, archived_at: b.archived ? '2026-10-12T13:45:00Z' : null } : t))); setReceipt('（房间演示：这里不发请求）已保存'); }}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 打赏核验屏的房间版。 */
function RewardsRoom() {
  const [filter, setFilter] = useState<RewardsFilter>({ state: 'pending' });
  const [notice, setNotice] = useState(DEMO_NOTICE_DEFAULTS);
  const [receipt, setReceipt] = useState<string | null>(null);
  return (
    <RewardsScreen
      items={DEMO_DONATIONS.filter((r) => r.state === filter.state)}
      hasMore={false}
      filter={filter}
      onFilterChange={setFilter}
      stats={DEMO_DONATION_STATS}
      noticeDefaults={notice}
      onSaveNoticeDefaults={(items) => { setNotice(items); setReceipt('（房间演示：这里不发请求）渠道默认文案已整表替换'); }}
      canVerify
      canSiteSetting
      onVerify={(ids, state, note) => setReceipt('（房间演示：这里不发请求）' + ids.length + ' 笔 → ' + state + '：' + (note || '（无说明）'))}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 举报屏的房间版。 */
function ReportsRoom() {
  const [filter, setFilter] = useState<ReportFilter>({ state: 'open', target_type: 'all' });
  const [receipt, setReceipt] = useState<string | null>(null);
  const items = DEMO_REPORTS.filter((r) => r.state === filter.state)
    .filter((r) => filter.target_type === 'all' || r.target_type === filter.target_type);
  return (
    <ReportsScreen
      items={items}
      hasMore={false}
      filter={filter}
      onFilterChange={setFilter}
      canHandle
      onHandle={(ids, state, note) => setReceipt('（房间演示：这里不发请求）' + ids.length + ' 条 → ' + state + '：' + note)}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 审核屏的房间版：数据来自 ./mock/fixtures，动作只留一条回执（房间不发请求）。 */
function ReviewRoom() {
  const [filter, setFilter] = useState<ReviewFilter>({ state: 'pending', board: 'all', q: '' });
  const [receipt, setReceipt] = useState<string | null>(null);
  const items = DEMO_REVIEW.filter((r) => filter.state === 'all' ? r.review_state !== 'approved' : r.review_state === filter.state)
    .filter((r) => filter.board === 'all' || r.board.slug === filter.board)
    .filter((r) => !filter.q.trim() || r.title.includes(filter.q.trim()));
  return (
    <ReviewScreen
      items={items}
      hasMore={false}
      filter={filter}
      onFilterChange={setFilter}
      canReview
      onReview={(item, action, note) => setReceipt('（房间演示：这里不发请求）' + (action === 'approve' ? '通过' : '拒绝') + '「' + item.title + '」：' + (note || '（无备注）'))}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 用户屏的房间版：数据来自 ./mock/fixtures，动作只留一条回执（房间不发请求）。 */
function UsersRoom() {
  const can = (perm: string) => (CURRENT_ADMIN.extra_permissions as readonly { key: string }[]).some((p) => p.key === perm)
    || ['post.review', 'report.handle', 'reward.verify'].includes(perm);
  const [filter, setFilter] = useState<UsersFilter>({ q: '', status: 'all', role: 'all' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  // 翻页在房间里也要真的换数据：**切本页那 20 行**（真站是换游标去取下一页，见 routes/admin/users.tsx）。
  // 这里不假装「共 N 人」是服务端给的 —— 房间的 counts 就是本地的演示数，数出来的与本页同源。
  const [page, setPage] = useState(1);
  const say = (msg: string) => setReceipt('（房间演示：这里不发请求）' + msg);
  // 房间的演示数据只有 6 个人，用 4 条一页才看得到翻页（真站是 20，见 lib/api/paging.ts 的 PAGE_LIMIT）
  const roomSize = 4;
  // 筛选在房间里要真的筛：真站在服务端筛（?q=&status=&role=），房间只有这一份数据。
  // 三根轴的口径照 auth/pgsql/admin_users.go：status / activated_at / email_verified_at **不合并**。
  const q = filter.q.trim().toLowerCase();
  const hit = DEMO_USERS.filter((u) =>
    (!q || [u.username, u.nickname, u.email].some((v) => v.toLowerCase().includes(q)))
    && (filter.status === 'all'
      || (filter.status === 'banned' && u.status === 'banned')
      || (filter.status === 'normal' && u.status !== 'banned' && u.activated_at !== null)
      || (filter.status === 'pending_act' && u.activated_at === null)
      || (filter.status === 'unverified' && u.email_verified_at === null))
    && (filter.role === 'all' || u.role.key === filter.role));
  const counts: UsersCounts = {
    total: hit.length,
    banned: hit.filter((u) => u.status === 'banned').length,
    pending_activation: hit.filter((u) => !u.activated_at).length,
    email_unverified: hit.filter((u) => !u.email_verified_at).length,
  };
  const pages = Math.max(1, Math.ceil(counts.total / roomSize));
  const shown = hit.slice((page - 1) * roomSize, page * roomSize);
  return (
    <UsersScreen
      users={shown}
      // 房间里的「详情」就是本地的三张表（真站那一份由 GET /admin/users/{id} 给，见 routes/admin/users.tsx）
      detail={activeId ? DEMO_USER_DETAIL[activeId] ?? null : null}
      onSelect={setActiveId}
      counts={counts}
      page={page}
      canNext={page < pages}
      onPage={setPage}
      size={roomSize}
      filter={filter}
      onFilterChange={(f) => { setFilter(f); setPage(1); }}
      roles={DEMO_ROLES}
      titles={DEMO_TITLES}
      canBan={can('user.ban')}
      canAssignRole={can('role.assign')}
      canGrantTitle={can('title.grant')}
      onBan={(ids, action, reason) => say((action === 'ban' ? '停用 ' : '解封 ') + ids.length + ' 人：' + reason)}
      onActivate={(ids) => say('激活 ' + ids.length + ' 个账号（只写 activated_at）')}
      onRevokeSessions={(id) => say('踢掉 ' + id + ' 的全部会话')}
      onSetRole={(id, roleId) => say('把 ' + id + ' 的基线角色改成 ' + roleId)}
      onGrantTitle={(userId, titleId) => say('给 ' + userId + ' 授予 ' + titleId)}
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

function initialScreen(): ScreenKey {
  const q = new URLSearchParams(location.search).get('screen');
  return SCREEN_KEYS.find((k) => k === q) ?? 'users';
}

export default function AdminPage() {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  // 当前登录者：房间给**演示用的一个人**（CURRENT_ADMIN），角色名从 DEMO_ROLES 取（那一份才是角色的唯一出处）。
  // `?me=0` 是「拿不到 session」那一态 —— 卡整块不画（D14 的两态都要出图，房间与产品页同一套判据）。
  const role = DEMO_ROLES.find((r) => r.key === CURRENT_ADMIN.role_key) ?? null;
  const me: AdminSelf | null = new URLSearchParams(location.search).get('me') === '0' ? null : {
    nickname: CURRENT_ADMIN.nickname,
    handle: CURRENT_ADMIN.handle,
    role: role ? { key: role.key, name: role.name } : null,
    avatar: null,
  };
  return (
    <AdminShell
      screen={screen}
      onScreen={setScreen}
      me={me}
      meExtra={CURRENT_ADMIN.extra_permissions.map((p) => ({ ...p }))}
    >
      {SCREENS[screen]()}
    </AdminShell>
  );
}
