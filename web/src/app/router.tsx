import { lazy } from 'react';
// 只从主入口引：v7 的 'react-router' 与 'react-router/dom' 会解析成两个模块副本，
// context 因此为 null（双包实例陷阱，React 18 + vitest 下必现）。
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router';
import { ROUTER_BASENAME } from '@/lib/base';
import { Shell } from './shell';
import { RouteError } from './error-boundary';
import { routePath } from '@/lib/url';
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
// **申诉暂不上线**：`POST /api/v1/appeals` 后端不存在（§21.2 里只有帖子的 review/appeal，那条也没实现）。
// 留着一个填完必然失败的表单比没有更糟，所以整页隐藏、入口也撤掉（见 完全重构/UI与后端对齐.md 第二节）。
const AdminLayout = lazy(() => import('@/routes/admin').then((m) => ({ default: m.AdminLayout })));
const NotFoundPage = lazy(() => import('@/routes/not-found').then((m) => ({ default: m.NotFoundPage })));
const NotificationsPage = lazy(() => import('@/routes/notifications').then((m) => ({ default: m.NotificationsPage })));
// 「我的」：收藏 + 举报进展。盲测发现这两个入口在界面上根本不存在（接口一直在）。
const MePage = lazy(() => import('@/routes/me').then((m) => ({ default: m.MePage })));
// 搜索**内嵌在首页**（用户明确要求「不要单独开一个页面」）：/search 只做重定向，
// 老链接与书签仍然有效，但不再有第二个页面要维护。
const SearchRedirect = () => <Navigate to={routePath('')} replace />;
const MessagesPage = lazy(() => import('@/routes/messages').then((m) => ({ default: m.MessagesPage })));
const DownloadPage = lazy(() => import('@/routes/download').then((m) => ({ default: m.DownloadPage })));
// 问题反馈整页（DevRoom 13-issue 接真端点）。入口参数：?topic=<资源帖 public id> 定范围与新建落点，?kind= 预设类型。
const IssuesPage = lazy(() => import('@/routes/issues').then((m) => ({ default: m.IssuesPage })));

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
        // { path: 'appeal', element: <AppealPage /> },  // 后端端点不存在，整页隐藏（2026-10-13）
        { path: 'settings', element: <SettingsPage /> },
        { path: 'notifications', element: <NotificationsPage /> },
        { path: 'me', element: <MePage /> },
        { path: 'issues', element: <IssuesPage /> },
        // /messages 与 /messages/:handle 是同一屏：左边会话列表 + 右边会话（后者是 URL 里的选中态）
        { path: 'messages', element: <MessagesPage /> },
        { path: 'messages/:handle', element: <MessagesPage /> },
        { path: 'search', element: <SearchRedirect /> },
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
