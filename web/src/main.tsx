import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from '@/app/router';
import { Providers } from '@/app/providers';
import '@/styles/index.css';
// Ring UI 是核心控件库：它的样式必须在 Tailwind 之后（冲突以它为准）
import '@jetbrains/ring-ui-built/components/style.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在：index.html 与前端入口不一致');

createRoot(root).render(
  <StrictMode>
    <Providers>
      <AppRouter />
    </Providers>
  </StrictMode>,
);
