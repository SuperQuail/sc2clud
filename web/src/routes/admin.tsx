import { createElement, Suspense, type ComponentType } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Lock } from 'lucide-react';
import { SCREEN_KEYS, type ScreenKey } from '@/devroom/pages/15-admin/nav';
import { AdminShell } from '@/devroom/pages/15-admin/shell';
import { appPath, routePath } from '@/lib/url';
import { can, useSession } from '@/lib/perms';
import { AiReviewScreenContainer } from './admin/ai';
import { AuditScreenContainer } from './admin/audit';
import { BoardsScreenContainer } from './admin/boards';
import { DiagnosticsScreenContainer } from './admin/diagnostics';
import { MailScreenContainer } from './admin/mail';
import { MailTemplateScreenContainer } from './admin/mail-tpl';
import { ReportsScreenContainer } from './admin/reports';
import { ReviewScreenContainer } from './admin/review';
import { RewardsScreenContainer } from './admin/rewards';
import { RolesScreenContainer } from './admin/roles';
import { SettingsScreenContainer } from './admin/settings';
import { TitlesScreenContainer } from './admin/titles';
import { UsersScreenContainer } from './admin/users';
import { Empty, ErrorState, Loading } from './_parts/state';

// 管理后台（契约 /admin/*，前端方案 §6「在路由层声明所需权限点，缺权限直接渲染 403，不发无谓请求」）。
//
// 路由与舞台复用 DevRoom 15-admin 的 NAV / SideNav / **AdminShell**（面包屑 + 当前管理员卡 + 权限明细）
// 与 12 个屏组件本身 —— 同一份实现，不是两份（上线设计 P2 决策 2/3）。
//
// 接线形状：**路由只声明权限点与布局**，取数在 ./admin/ 目录里（一屏一个容器文件）；
//（一个屏一个容器，容器把 /admin/* 变成屏的 props；屏里不 import mock、不发请求）。
// 这样「一屏接完」的判据只有一条：**12 屏的映射表里都是容器，没有一个是占位屏**。
// 曾经有过一个 PendingScreen（端点没到时渲染「这一屏还没有可以对接的端点」），C1/C2/C3 落地后
// 它已经没有使用者，所以连工厂一起删了 —— 留着它，下一个人就会以为还有哪一屏没接。

/** 每屏所需的权限点。**照后端 authz 常量写**（forum/internal/authz），不再有第二套命名。 */
const PERM_BY_SCREEN: Record<ScreenKey, string> = {
  users: 'user.ban',
  roles: 'role.edit',
  boards: 'board.manage',
  review: 'post.review',
  reports: 'report.handle',
  rewards: 'reward.verify',
  titles: 'title.manage',
  mail: 'mail.manage',
  mailtpl: 'site.setting',
  ai: 'site.setting',
  settings: 'site.setting',
  audit: 'audit.view',
  diagnostics: 'site.setting',
};

// 屏的映射。**不再逐个 lazy()**：容器要 import 屏（屏是纯 props 组件），屏与容器成对进来；
// 再包一层 lazy 只会把同一份代码切成两半、多一次往返。整块切分由路由层负责
//（上线的 router.tsx 里 /admin/* 是 lazy 的，所以这 12 屏不会进首屏）。
// 代价：12 屏现在落在同一个 chunk 里 —— 体积门禁（gate:budget 的单路由 chunk ≤ 120KB）是判据。
type AnyScreen = ComponentType<Record<string, never>>;

const SCREEN_COMPONENT: Record<ScreenKey, AnyScreen> = {
  users: UsersScreenContainer,
  roles: RolesScreenContainer,
  boards: BoardsScreenContainer,
  review: ReviewScreenContainer,
  reports: ReportsScreenContainer,
  rewards: RewardsScreenContainer,
  titles: TitlesScreenContainer,
  mail: MailScreenContainer,
  mailtpl: MailTemplateScreenContainer,
  settings: SettingsScreenContainer,
  ai: AiReviewScreenContainer,
  audit: AuditScreenContainer,
  diagnostics: DiagnosticsScreenContainer,
};

export function AdminLayout() {
  const session = useSession();
  const params = useParams();
  const navigate = useNavigate();
  const raw = params['*'] ?? 'users';
  const screen = (SCREEN_KEYS as string[]).includes(raw) ? (raw as ScreenKey) : null;

  if (session.isLoading) return <Loading what='管理员身份' />;
  if (session.error) return <ErrorState what='管理员身份' error={session.error} />;
  if (!session.isLoggedIn) {
    return (
      <Empty
        icon={Lock}
        title='管理后台需要登录'
        hint='后台的每一项都要权限点，未登录时连列表都不请求（前端方案 §6）。'
        action={<Button primary href={appPath('login?next=' + encodeURIComponent(routePath('admin/users')))}>去登录</Button>}
      />
    );
  }
  if (screen === null) return <Navigate to={routePath('admin/users')} replace />;

  // 权限点按 **/me 的真实 perms** 判（@/lib/perms）。这里**不再有「perms 为空就不拦」的放宽**：
  // 那个放宽是接线期间的临时态，而它的代价是「没有权限的人也进得来，然后每一屏都 403」。
  if (!can(session.session, PERM_BY_SCREEN[screen])) {
    return (
      <Empty
        icon={Lock}
        title='没有这一屏的权限'
        hint={
          '当前账号缺少 ' + PERM_BY_SCREEN[screen] + '（前端方案 §6：缺权限直接渲染 403，不发无谓请求）。' +
          '真正的拦截在后端 authz，这里只是不让你白跑一趟。'
        }
        action={<Button href={appPath('')}>回首页</Button>}
      />
    );
  }

  return (
    <AdminShell
      screen={screen}
      onScreen={(key) => void navigate(routePath('admin/' + key))}
      // D14：喂**真 session**（昵称 / @handle / 基线角色 / 头像）。session 为空时 AdminShell 整块不画 ——
      // 以前这里没有这一行，AdminShell 就显示自己写死的「示范管理员 @demo-admin」，
      // 于是每个登录者看到的都是同一个人（那是 DevRoom 时期的 mock 漏进了产品）。
      me={session.session ? {
        nickname: session.session.nickname,
        handle: session.session.handle,
        role: session.session.role ?? null,
        avatar: session.session.avatar ?? null,
      } : null}
      // **后端 /me 的 extra 只有 key 与 expires_at，没有 reason**（读接口不回显理由）——
      // 所以这里不编一个理由出来，缺就是缺（权限明细里那一段会空着）。
      meExtra={(session.session?.extra ?? []).map((p) => ({ key: p.key, reason: '', expires_at: p.expires_at }))}
    >
      {/* 每个屏自己一个 chunk：加载态必须有（否则切屏时是一片空白） */}
      <Suspense fallback={<Loading what='这一屏' />}>{createElement(SCREEN_COMPONENT[screen])}</Suspense>
    </AdminShell>
  );
}

/** 旧的 /admin 入口（没有屏）也走同一个组件：它会把人送到 /admin/users */
export function AdminIndex() {
  return <Navigate to={routePath('admin/users')} replace />;
}

// 顶栏那颗「管理后台」在 ./_parts/admin-entry.tsx —— 单独放是为了不让壳把 12 个后台屏拖进首屏。
