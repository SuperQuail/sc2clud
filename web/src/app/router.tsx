import { lazy } from 'react';
// 只从主入口引：v7 的 'react-router' 与 'react-router/dom' 会解析成两个模块副本，
// context 因此为 null（双包实例陷阱，React 18 + vitest 下必现）。
import { RouterProvider, createBrowserRouter } from 'react-router';
import { ROUTER_BASENAME } from '@/lib/base';
import { Shell } from './shell';
import { RouteError } from './error-boundary';
import { HomePage } from '@/routes/home';
import { TopicPage } from '@/routes/topic';

// 唯一的路由定义处（前端方案 §6）。路径以 v2 §21.2 的契约为准，**不自创路径**。
//
// 分割策略（前端方案 §6）：
//   · **公开首屏不分割** —— 首页与帖子页是搜索引擎/外链直接落地的那两页；
//   · 其余按需 lazy。这样首屏 JS 预算（150KB gzip）只花在真正首屏要用的东西上，
//     而每一个懒加载页都必须是「自己进去才下载」的（体积门禁还盯着最大路由 chunk ≤ 60KB）。
const LoginPage = lazy(() => import('@/routes/login').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('@/routes/register').then((m) => ({ default: m.RegisterPage })));
const VerifyPage = lazy(() => import('@/routes/register-verify').then((m) => ({ default: m.VerifyPage })));
const BoardPage = lazy(() => import('@/routes/board').then((m) => ({ default: m.BoardPage })));
const ProfilePage = lazy(() => import('@/routes/profile').then((m) => ({ default: m.ProfilePage })));
const SettingsPage = lazy(() => import('@/routes/settings').then((m) => ({ default: m.SettingsPage })));
const ComposePage = lazy(() => import('@/routes/compose').then((m) => ({ default: m.ComposePage })));
const AppealPage = lazy(() => import('@/routes/appeal').then((m) => ({ default: m.AppealPage })));
const AdminLayout = lazy(() => import('@/routes/admin').then((m) => ({ default: m.AdminLayout })));
const NotFoundPage = lazy(() => import('@/routes/not-found').then((m) => ({ default: m.NotFoundPage })));
const NotificationsPage = lazy(() => import('@/routes/stubs').then((m) => ({ default: m.NotificationsPage })));
// 「我的」：收藏 + 举报进展。盲测发现这两个入口在界面上根本不存在（接口一直在）。
const MePage = lazy(() => import('@/routes/me').then((m) => ({ default: m.MePage })));
const SearchPage = lazy(() => import('@/routes/stubs').then((m) => ({ default: m.SearchPage })));
const MessagesPage = lazy(() => import('@/routes/stubs').then((m) => ({ default: m.MessagesPage })));
const DownloadPage = lazy(() => import('@/routes/stubs').then((m) => ({ default: m.DownloadPage })));

const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <Shell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <HomePage /> },
        { path: 'b/:slug', element: <BoardPage /> },
        { path: 't/:topicId', element: <TopicPage /> },
        { path: 'u/:handle', element: <ProfilePage /> },
        { path: 'new', element: <ComposePage /> },
        { path: 'login', element: <LoginPage /> },
        { path: 'register', element: <RegisterPage /> },
        { path: 'register/verify', element: <VerifyPage /> },
        { path: 'appeal', element: <AppealPage /> },
        { path: 'settings', element: <SettingsPage /> },
        { path: 'notifications', element: <NotificationsPage /> },
        { path: 'me', element: <MePage /> },
        // /messages/:handle 也落在这一屏：私信端点没接之前，两个路径给的是同一句实话
        { path: 'messages', element: <MessagesPage /> },
        { path: 'messages/:handle', element: <MessagesPage /> },
        { path: 'search', element: <SearchPage /> },
        { path: 'download', element: <DownloadPage /> },
        { path: 'admin/*', element: <AdminLayout /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: ROUTER_BASENAME },
);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
