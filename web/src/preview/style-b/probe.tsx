import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';
import '@/styles/ring-ui-bridge.css';
import V1 from './v1';
import V2 from './v2';

const dark = window.location.search.includes('dark');
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
if (dark) document.documentElement.classList.add('ring-ui-theme-dark');

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <div style={{ padding: 24, background: 'var(--background)' }}>
    <V1 />
    <V2 />
  </div>,
);
