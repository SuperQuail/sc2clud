import { useState } from 'react';
import { CURRENT_ADMIN } from './mock/perms';
import { AdminShell } from './shell';
import { SCREEN_KEYS, type ScreenKey } from './nav';
import { AiReviewScreen } from './screens/ai-review';
import { AuditScreen } from './screens/audit';
import { BoardsScreen } from './screens/boards';
import { DiagnosticsScreen } from './screens/diagnostics';
import { MailScreen } from './screens/mail';
import { ReportsScreen } from './screens/reports';
import { ReviewScreen } from './screens/review';
import { RewardsScreen } from './screens/rewards';
import { RolesScreen } from './screens/roles';
import { SettingsScreen } from './screens/settings';
import { TitlesScreen } from './screens/titles';
import { UsersScreen } from './screens/users';

// DevRoom 15 · 管理后台（对照老站 13.1–13.15 与后端 §9.8 / §20.4 D6 / §21.2）。
// 对照表在 ./admin-map.md；数据与权限都是本目录内的 mock（不 fetch、不接 api client）。
// 屏切换：真实实现是 /admin/<屏> 的路由 + 每屏声明权限点（前端方案 §6）；DevRoom 里用 ?screen= 初值 + 本地状态，
// 这样出图/评审能直接给到某一屏（「URL 即状态」的最小版本）。
const SCREENS: Record<ScreenKey, () => React.ReactNode> = {
  users: () => <UsersScreen />,
  roles: () => <RolesScreen />,
  boards: () => <BoardsScreen />,
  review: () => <ReviewScreen />,
  reports: () => <ReportsScreen />,
  rewards: () => <RewardsScreen />,
  titles: () => <TitlesScreen />,
  mail: () => <MailScreen />,
  settings: () => <SettingsScreen />,
  ai: () => <AiReviewScreen />,
  audit: () => <AuditScreen />,
  diagnostics: () => <DiagnosticsScreen />,
};

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