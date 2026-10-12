import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 临时探针配置（出图用，用完删除）：root 必须是 web/，否则 /src/** 取不到，会回落到产品 index.html
export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
});
