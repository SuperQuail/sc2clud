import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 方向 C 自己的预览配置：只因为 preview.html 的入口清单是共享文件（并行做变体时不动它）。
// 端口与产物目录都另起一套；选定方向后这份配置连同目录一起删。
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5198, strictPort: true },
  build: { outDir: 'preview-dist-c', emptyOutDir: true, rollupOptions: { input: { preview: 'preview-c.html' } } },
});
