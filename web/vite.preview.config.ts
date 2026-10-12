import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 预览专用配置：与产品构建彻底分开（产物进 preview-dist，不进 dist，也不进体积门禁）
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5199, strictPort: true },
  build: { outDir: 'preview-dist', emptyOutDir: true, rollupOptions: { input: { preview: 'preview.html' } } },
});
