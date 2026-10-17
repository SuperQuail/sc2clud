import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';
import { Providers } from '@/app/providers';
import { DevRoom } from './app';

const page = new URLSearchParams(location.search).get('page') ?? '01-button';
const el = document.getElementById('root');
if (!el) throw new Error('#root 不存在');
createRoot(el).render(
  <StrictMode>
    {/* 房间也要 Providers：10-messages 这一屏的 View 吃 react-query（数据端口由宿主注入，
        但缓存与失效机制仍要一个 QueryClient）。其它页不取数，包着它们没有副作用。 */}
    <Providers>
      <DevRoom page={page} />
    </Providers>
  </StrictMode>,
);
