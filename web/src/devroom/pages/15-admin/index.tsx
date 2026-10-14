import { useState } from 'react';
import { CURRENT_ADMIN } from './mock/perms';
import { DEMO_ANNOUNCEMENTS, DEMO_AUDIT, DEMO_BANNERS, DEMO_DOMAINS, DEMO_DONATIONS, DEMO_DONATION_STATS, DEMO_MAIL, DEMO_NOTICE_DEFAULTS, DEMO_REPORTS, DEMO_REVIEW, DEMO_ROLES, DEMO_SETTINGS, DEMO_TITLES, DEMO_USERS } from './mock/fixtures';
import { AdminShell } from './shell';
import { SCREEN_KEYS, type ScreenKey } from './nav';
import { AiReviewScreen } from './screens/ai-review';
import { AuditScreen, type AuditFilter } from './screens/audit';
import { BoardsScreen } from './screens/boards';
import { DiagnosticsScreen } from './screens/diagnostics';
import { MailScreen } from './screens/mail';
import { ReportsScreen, type ReportFilter } from './screens/reports';
import { ReviewScreen, type ReviewFilter } from './screens/review';
import { RewardsScreen, type RewardsFilter } from './screens/rewards';
import { RolesScreen } from './screens/roles';
import { SettingsScreen } from './screens/settings';
import { TitlesScreen } from './screens/titles';
import { UsersScreen, type UsersFilter } from './screens/users';

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
  roles: () => <RolesScreen />,
  boards: () => <BoardsScreen />,
  review: () => <ReviewRoom />,
  reports: () => <ReportsRoom />,
  rewards: () => <RewardsRoom />,
  titles: () => <TitlesRoom />,
  mail: () => <MailRoom />,
  settings: () => <SettingsRoom />,
  ai: () => <AiReviewScreen />,
  audit: () => <AuditRoom />,
  diagnostics: () => <DiagnosticsScreen />,
};

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
      onPatch={(id, p) => { setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } : a))); setReceipt('（房间演示：这里不发请求）已保存 ' + Object.keys(p).join('、')); }}
      onDelete={(id) => { setAccounts((prev) => prev.filter((a) => a.id !== id)); setReceipt('（房间演示：这里不发请求）账号已删除'); }}
      onTest={(id, to) => setReceipt('（房间演示：这里不发请求）给 ' + to + ' 发一封测试信（账号 ' + id + '）')}
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
      onCreate={(b) => { setTitles((p) => [...p, { id: 't-' + (p.length + 1), ...b, archived_at: null }]); setReceipt('（房间演示：这里不发请求）已新建「' + b.name + '」'); }}
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
  const [receipt, setReceipt] = useState<string | null>(null);
  const say = (msg: string) => setReceipt('（房间演示：这里不发请求）' + msg);
  return (
    <UsersScreen
      users={DEMO_USERS}
      total={DEMO_USERS.length}
      filter={filter}
      onFilterChange={setFilter}
      roles={DEMO_ROLES}
      titles={DEMO_TITLES}
      canBan={can('user.ban')}
      canAssignRole={can('role.assign')}
      canGrantTitle={can('title.grant')}
      onBan={(ids, action, reason) => say((action === 'ban' ? '停用 ' : '解封 ') + ids.length + ' 人：' + reason)}
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
  return (
    <AdminShell
      screen={screen}
      onScreen={setScreen}
      meExtra={CURRENT_ADMIN.extra_permissions.map((p) => ({ ...p }))}
    >
      {SCREENS[screen]()}
    </AdminShell>
  );
}
