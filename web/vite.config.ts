import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相对 base：资源 URL 写成 ./assets/…，由 <base href> 决定最终前缀。
  // 不能用绝对 '/assets/'：dev 实例在 /dev/ 下会去加载生产的前端产物（盲审 F01）。
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // 开发期同域：只请求 /api，转发到后端，与生产形态一致（前端方案 §10.1）
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});