import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';
import { DevRoom } from './app';

const page = new URLSearchParams(location.search).get('page') ?? '01-button';
const el = document.getElementById('root');
if (!el) throw new Error('#root 不存在');
createRoot(el).render(
  <StrictMode>
    <DevRoom page={page} />
  </StrictMode>,
);
