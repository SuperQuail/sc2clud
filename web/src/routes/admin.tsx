import { createElement, lazy, Suspense, type LazyExoticComponent, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { SideNav } from '@/devroom/pages/15-admin/side-nav';
import { NAV, SCREEN_KEYS, type ScreenKey } from '@/devroom/pages/15-admin/nav';
// 12 个屏**逐个按需加载**：静态 import 会把它们（连同各自的 mock 表与重控件）打进同一个 chunk，
// 那个 chunk 一旦超过体积预算就会把整条门禁拖红（实测 66KB gzip）。按屏分割后每个屏只在点开它时下载。
const SCREEN_COMPONENT: Record<ScreenKey, LazyExoticComponent<() => ReactNode>> = {
  users: lazy(() => import('@/devroom/pages/15-admin/screens/users').then((m) => ({ default: m.UsersScreen }))),
  roles: lazy(() => import('@/devroom/pages/15-admin/screens/roles').then((m) => ({ default: m.RolesScreen }))),
  boards: lazy(() => import('@/devroom/pages/15-admin/screens/boards').then((m) => ({ default: m.BoardsScreen }))),
  review: lazy(() => import('@/devroom/pages/15-admin/screens/review').then((m) => ({ default: m.ReviewScreen }))),
  reports: lazy(() => import('@/devroom/pages/15-admin/screens/reports').then((m) => ({ default: m.ReportsScreen }))),
  rewards: lazy(() => import('@/devroom/pages/15-admin/screens/rewards').then((m) => ({ default: m.RewardsScreen }))),
  titles: lazy(() => import('@/devroom/pages/15-admin/screens/titles').then((m) => ({ default: m.TitlesScreen }))),
  mail: lazy(() => import('@/devroom/pages/15-admin/screens/mail').then((m) => ({ default: m.MailScreen }))),
  settings: lazy(() => import('@/devroom/pages/15-admin/screens/settings').then((m) => ({ default: m.SettingsScreen }))),
  ai: lazy(() => import('@/devroom/pages/15-admin/screens/ai-review').then((m) => ({ default: m.AiReviewScreen }))),
  audit: lazy(() => import('@/devroom/pages/15-admin/screens/audit').then((m) => ({ default: m.AuditScreen }))),
  diagnostics: lazy(() => import('@/devroom/pages/15-admin/screens/diagnostics').then((m) => ({ default: m.DiagnosticsScreen }))),
};
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Lock, ShieldCheck } from 'lucide-react';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { appPath } from '@/lib/url';
import { can, useSession } from '@/lib/perms';
import { Empty, ErrorState, Loading } from './_parts/state';

// 管理后台（契约：/admin/*，前端方案 §6「在路由层声明所需权限点，缺权限直接渲染 403，不发无谓请求」）。
//
// 路由与侧栏直接复用 DevRoom 15-admin 的舞台：NAV（12 项 / 4 组）、SideNav（房子件），
// 以及 12 个屏组件本身 —— **同一份实现，不是两份**（上线设计 P2 决策 2/3：管理后台属于「先搬」的那一类）。
//
// 两件必须说清的事（否则后台看起来像已经接完了）：
//   ① 屏里的数据仍是 mock（各屏还没接 /admin/* 端点）—— 页面顶部有一条常驻说明，不装成真的；
//   ② 权限点常量：§21.2 写的是 post.* / user.ban / role.edit 这一套，而 RBAC权限树设计.md §3 用的是
//      topic.* / user.role.change / system.settings。**两套命名不一致，需 P1 定稿**（见回报）。
//      所以这里按「任一命名命中即放行」判定，并且在 /me 还没给出 perms 时**不拦**（P1 接线期间的默认）。
const PERM_BY_SCREEN: Record<ScreenKey, string> = {
  users: 'user.ban',
  roles: 'role.edit',
  boards: 'board.manage',
  review: 'post.review',
  reports: 'report.handle',
  rewards: 'reward.verify',
  titles: 'title.grant',
  mail: 'mail.manage',
  ai: 'post.review',
  settings: 'site.setting',
  audit: 'audit.view',
  diagnostics: 'site.setting',
};

/** 两套命名都给一遍，命中任一条即可（P1 定稿后删掉多余的那一套） */
const PERM_ALIASES: Record<string, string[]> = {
  'user.ban': ['user.ban', 'user.role.change'],
  'role.edit': ['role.edit'],
  'board.manage': ['board.manage'],
  'post.review': ['post.review', 'topic.move'],
  'report.handle': ['report.handle'],
  'reward.verify': ['reward.verify', 'donation.review'],
  'title.grant': ['title.grant'],
  'mail.manage': ['mail.manage'],
  'site.setting': ['site.setting', 'system.settings'],
  'audit.view': ['audit.view', 'audit.read'],
};

function allowed(session: { perms?: string[]; is_super?: boolean } | null, screen: ScreenKey): boolean {
  if (!session) return false;
  // /me 还没接（P1 期间 perms 为空数组）：**不拦**，否则后台整片 403，看不出接线进度
  if (!session.is_super && (session.perms ?? []).length === 0) return true;
  const keys = PERM_ALIASES[PERM_BY_SCREEN[screen]] ?? [PERM_BY_SCREEN[screen]];
  return keys.some((k) => can(session, k));
}



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
        action={<Button primary href={appPath('login?next=' + encodeURIComponent(appPath('admin/users')))}>去登录</Button>}
      />
    );
  }
  if (screen === null) return <Navigate to={appPath('admin/users')} replace />;
  if (!allowed(session.session, screen)) {
    return (
      <Empty
        icon={Lock}
        title='没有这一屏的权限'
        hint={
          '当前账号缺少 ' + PERM_BY_SCREEN[screen] + '（前端方案 §6：缺权限直接渲染 403，不发无谓请求）。' +
          '真正的拦截在后端，这里只是不让你白跑一趟。'
        }
        action={<Button href={appPath('')}>回首页</Button>}
      />
    );
  }

  const current = NAV.flatMap((g) => g.items).find((i) => i.key === screen);

  return (
    <div className='flex flex-col gap-3'>
      {/* 常驻说明：屏里的数据还是 DevRoom 的 mock。**不装成已接线**（盲审二号：点完没反应要能分清是哪种） */}
      <FormAlert
        tone='info'
        title='管理后台的界面已上线，数据还没接'
        description={
          '这一版把后台的导航、权限门与 12 个屏搬到了真实路由上；屏里的内容仍是 DevRoom 的示例数据。' +
          '各屏接 /admin/* 端点（§21.2 管理段）是下一步。'
        }
      />
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h1 className='m-0 flex items-center gap-2 text-[18px] font-semibold text-foreground'>
          <ShieldCheck aria-hidden className='size-4' />
          管理后台 · {current?.title ?? '用户管理'}
        </h1>
        <span className='text-[11px] text-muted-foreground'>
          所需权限点 {PERM_BY_SCREEN[screen]}
          {session.session?.is_super ? ' · 你是超级管理员（全放行）' : ''}
        </span>
      </div>

      <div className='grid items-start gap-3 lg:grid-cols-[164px_minmax(0,1fr)]'>
        <SideNav
          ariaLabel='后台分组导航'
          value={screen}
          onChange={(key) => void navigate(appPath('admin/' + key))}
          groups={NAV.map((g) => ({
            title: g.grp,
            items: g.items.map((i) => ({ key: i.key, label: i.title, count: i.badge ? Number(i.badge) : undefined })),
          }))}
        />
        <div className='flex min-w-0 flex-col gap-3'>
          {/* 每个屏自己一个 chunk：加载态必须有（否则切屏时是一片空白） */}
          <Suspense fallback={<Loading what='这一屏' />}>{createElement(SCREEN_COMPONENT[screen])}</Suspense>
        </div>
      </div>
    </div>
  );
}

/** 旧的 /admin 入口（没有屏）也走同一个组件：它会把人送到 /admin/users */
export function AdminIndex() {
  return <Navigate to={appPath('admin/users')} replace />;
}

// 顶栏那颗「管理后台」在 ./_parts/admin-entry.tsx —— 单独放是为了不让壳把 12 个后台屏拖进首屏。
