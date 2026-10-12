import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';
import '@/styles/ring-ui-bridge.css';
import V1 from './v1';
import V2 from './v2';

const q = new URLSearchParams(window.location.search);
const dark = q.has('dark');
const V = q.get('v') === '2' ? V2 : V1;
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
if (dark) document.documentElement.classList.add('ring-ui-theme-dark');

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(<V />);
