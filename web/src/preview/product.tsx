import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Providers } from '@/app/providers';
import { RouteError } from '@/app/error-boundary';
import { Shell } from '@/app/shell';
import { HomePage } from '@/routes/home';
import { installFixture } from './product-fixture';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';

// **产品页的预览入口**（`web/product.html`，只在 vite.preview.config.ts 里构建，不进产品产物）。
//
// 为什么要有它：产品路由页长期**出不了图** —— vite.preview.config.ts 的 rollupOptions.input 里只有
// preview / devroom / isolate 三个入口，而本机默认没有后端（127.0.0.1:8080 没起），页面只会停在加载态。
// 于是「改了产品页」只能过 typecheck 与单测，谁也没看过它长什么样。
//
// 它挂的是**真壳 + 真页面**（app/shell.tsx + routes/*）——与产品同一份代码、同一份令牌，不是第二套实现；
// 与产品入口的区别只有两点，都是为了「没有后端也能出图」：
//   ① 路由用 MemoryRouter（不进 HTML5 history）：地址栏不用背着 /messages、/issues 也能切路由，
//      所以静态服务（serve-preview.ts 没有 SPA fallback）与 vite dev 都能直接打开；
//   ② 数据用桩（?stub=1，默认）或真后端（?stub=0）。
//
// 用法：`pnpm preview:dev` 后开
//   http://127.0.0.1:5199/product.html?route=/              首页
//   http://127.0.0.1:5199/product.html?route=/messages      信息中心（顶栏的「私信」图标）
//   http://127.0.0.1:5199/product.html?route=/issues        问题反馈
//   &me=0 游客态、&theme=dark 深色、&stub=0 走真后端。
//
// **图上要能证明它拍的是当前源码**（交接单 §5.4）：左下角那块 `MARKER-PRODUCT-…` 就是干这个的。
const params = new URLSearchParams(location.search);
const route = params.get('route') ?? '/';
const loggedIn = params.get('me') !== '0';

// 主题：与 devroom.html 同一套（?theme= 优先，其次 localStorage，最后跟随系统）
(function applyTheme() {
  const q = params.get('theme');
  const p = q === 'light' || q === 'dark' || q === 'system' ? q : localStorage.getItem('theme');
  const want = p === 'light' || p === 'dark' ? p : 'system';
  const dark = want === 'dark' || (want === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (dark) document.documentElement.classList.add('ring-ui-theme-dark');
})();

// 游客态：桩里的 /me 直接回 data:null（与真后端「没登录 = 200 + null」一致）
// 请求流水留在 window 上：出图/联调时「页面到底要了哪些端点」是第一个要看的证据（出图脚本会读它）。
declare global {
  interface Window {
    __PRODUCT_FETCH_LOG?: Array<{ url: string; method: string }>;
  }
}
if (params.get('stub') !== '0') window.__PRODUCT_FETCH_LOG = installFixture();

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在：product.html 与预览入口不一致');

const router = createMemoryRouter(
  [
    {
      path: '/',
      element: <Shell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <HomePage /> },
        { path: 'messages', lazy: () => import('@/routes/messages').then((m) => ({ Component: m.MessagesPage })) },
        { path: 'messages/:handle', lazy: () => import('@/routes/messages').then((m) => ({ Component: m.MessagesPage })) },
        { path: 'issues', lazy: () => import('@/routes/issues').then((m) => ({ Component: m.IssuesPage })) },
        { path: 't/:topicId', lazy: () => import('@/routes/topic').then((m) => ({ Component: m.TopicPage })) },
        { path: 'notifications', lazy: () => import('@/routes/notifications').then((m) => ({ Component: m.NotificationsPage })) },
      ],
    },
  ],
  { initialEntries: [route] },
);

createRoot(root).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);

// 可见标记：出图脚本从图上读得到它，才证明这张图渲染的是**当前源码**（交接单 §5.4 的固定动作）
const marker = document.createElement('p');
marker.dataset.testid = 'product-preview-marker';
marker.textContent = 'MARKER-PRODUCT-' + (loggedIn ? 'LOGIN' : 'GUEST') + ' ' + route;
marker.setAttribute(
  'style',
  'position:fixed;left:8px;bottom:8px;z-index:99999;background:#111;color:#0f0;font:12px monospace;padding:2px 6px;border-radius:4px',
);
document.body.appendChild(marker);
