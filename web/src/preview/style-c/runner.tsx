import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';
import '@/styles/ring-ui-bridge.css';
import V1 from './v1';
import V2 from './v2';

// 方向 C 的预览入口：s=c 固定，?v=1|2 选变体，?theme=light|dark，?view=card|compact 由页面自己读
const VARIANTS = { '1': V1, '2': V2 } as const;
const v = new URLSearchParams(location.search).get('v') ?? '1';
const Page = v === '2' ? VARIANTS['2'] : VARIANTS['1'];

const el = document.getElementById('root');
if (!el) throw new Error('#root 不存在');
createRoot(el).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
