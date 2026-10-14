import { useState } from 'react';
import { CURRENT_ADMIN } from './mock/perms';
import { DEMO_REVIEW, DEMO_ROLES, DEMO_TITLES, DEMO_USERS } from './mock/fixtures';
import { AdminShell } from './shell';
import { SCREEN_KEYS, type ScreenKey } from './nav';
import { AiReviewScreen } from './screens/ai-review';
import { AuditScreen } from './screens/audit';
import { BoardsScreen } from './screens/boards';
import { DiagnosticsScreen } from './screens/diagnostics';
import { MailScreen } from './screens/mail';
import { ReportsScreen } from './screens/reports';
import { ReviewScreen, type ReviewFilter } from './screens/review';
import { RewardsScreen } from './screens/rewards';
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
  reports: () => <ReportsScreen />,
  rewards: () => <RewardsScreen />,
  titles: () => <TitlesScreen />,
  mail: () => <MailScreen />,
  settings: () => <SettingsScreen />,
  ai: () => <AiReviewScreen />,
  audit: () => <AuditScreen />,
  diagnostics: () => <DiagnosticsScreen />,
};

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
