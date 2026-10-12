import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';
import '@/styles/ring-ui-bridge.css';
import A1 from './style-a/v1';
import A2 from './style-a/v2';
import B1 from './style-b/v1';
import B2 from './style-b/v2';
import D1 from './style-d/v1';
import D2 from './style-d/v2';

// 预览入口：?s=a|b|d&v=1|2&theme=light|dark
// 独立于产品入口（preview.html），不进 index 的构建产物
const VARIANTS = { a1: A1, a2: A2, b1: B1, b2: B2, d1: D1, d2: D2 } as const;
type Key = keyof typeof VARIANTS;

const p = new URLSearchParams(location.search);
const key = ((p.get('s') ?? 'a') + (p.get('v') ?? '1')) as Key;
const Page = VARIANTS[key] ?? A1;

const el = document.getElementById('root');
if (!el) throw new Error('#root 不存在');
createRoot(el).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
