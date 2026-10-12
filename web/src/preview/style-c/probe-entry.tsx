import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@jetbrains/ring-ui-built/components/style.css';
import '@/styles/ring-ui-bridge.css';
import Probe from './probe';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Probe />
  </StrictMode>,
);
