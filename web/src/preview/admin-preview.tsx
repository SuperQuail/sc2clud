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

// **管理后台专用出图入口**（`web/admin.html`，只在 vite.preview.config.ts 里构建，不进产品产物）。
//
// 为什么不让 W-D2 直接往 product.html 的 route 表里加 /admin/*：
// 那个文件是**共享写入点**（交接单 §2 的冻结清单把 preview/main.tsx 列为只有 Lead 能动），
// 而此刻另一个人（W-D1）正在改 product-fixture.ts。两个人在同一个文件上追加路由，
// 冲突时要靠人读 diff 才能把两边都保住 —— 不如各出各的入口，谁也不用碰谁的文件。
//
// 用法：`npx vite --config vite.preview.config.ts --port 5212` 后开
//   http://127.0.0.1:5212/admin.html?route=/admin/review&asAdmin=1
//   （&asAdmin=1 换管理员身份；不加就是普通成员，能拍到「没有这一屏的权限」那一态）
// 图上要能证明它拍的是当前源码：左下角那块 MARKER-ADMIN-… 就是干这个的。
const params = new URLSearchParams(location.search);
const route = params.get('route') ?? '/admin/review';

(function applyTheme() {
  const q = params.get('theme');
  const p = q === 'light' || q === 'dark' || q === 'system' ? q : localStorage.getItem('theme');
  const want = p === 'light' || p === 'dark' ? p : 'system';
  const dark = want === 'dark' || (want === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (dark) document.documentElement.classList.add('ring-ui-theme-dark');
})();

if (params.get('stub') !== '0') installFixture();

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在：admin.html 与 admin-preview.tsx 不一致');

const router = createMemoryRouter(
  [
    {
      path: '/',
      element: <Shell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <HomePage /> },
        { path: 'admin', lazy: () => import('@/routes/admin').then((m) => ({ Component: m.AdminIndex })) },
        { path: 'admin/*', lazy: () => import('@/routes/admin').then((m) => ({ Component: m.AdminLayout })) },
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

const marker = document.createElement('p');
marker.dataset.testid = 'admin-preview-marker';
marker.textContent = 'MARKER-ADMIN ' + route;
marker.setAttribute(
  'style',
  'position:fixed;left:8px;bottom:8px;z-index:99999;background:var(--foreground);color:var(--background);font:12px monospace;padding:2px 6px;border-radius:4px',
);
document.body.appendChild(marker);
