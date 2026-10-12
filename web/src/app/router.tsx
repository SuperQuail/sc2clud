// 只从主入口引：v7 的 'react-router' 与 'react-router/dom' 会解析成两个模块副本，
// context 因此为 null（双包实例陷阱，React 18 + vitest 下必现）。
import { RouterProvider, createBrowserRouter } from 'react-router';
import { ROUTER_BASENAME } from '@/lib/base';
import { Shell } from './shell';
import { RouteError } from './error-boundary';
import { HomePage } from '@/routes/home';
import { NotFoundPage } from '@/routes/not-found';

// 唯一的路由定义处（前端方案 §6）。页面按需 lazy，公开首页不分割。
const router = createBrowserRouter(
  [
  {
    path: '/',
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  ],
  { basename: ROUTER_BASENAME },
);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
