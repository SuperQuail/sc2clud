import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 预览专用配置：与产品构建彻底分开（产物进 preview-dist，不进 dist，也不进体积门禁）
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5199,
    strictPort: true,
    // 子 agent 跑截图会留下 Chrome 用户目录（.tmp-*）；Vite 默认会 watch 它，
    // Chrome 锁着文件就 EBUSY，把 dev server 搞死——所以显式忽略
    watch: { ignored: ['**/.tmp-*/**', '**/node_modules/**', '**/dist/**', '**/preview-dist/**'] },
  },
  // product 是**产品路由页**的预览入口（真壳 + 真页面，桩数据见 src/preview/product-fixture.ts）：
  // 没有它，产品页只能过 typecheck/单测、出不了图（交接单 §4.B.8 / 开发必读 §8）。
  build: {
    outDir: 'preview-dist',
    emptyOutDir: true,
    rollupOptions: {
      // admin 是**管理后台的出图入口**（web/admin.html + src/preview/admin-preview.tsx，W-D2）：
      // /admin/* 不在 product.html 的 route 表里，而那个文件是共享写入点、当时还有人在改，
      // 所以后台自己一个入口（同样是真壳 + 真路由 + 真屏，只换桩数据）。
      input: { preview: 'preview.html', devroom: 'devroom.html', isolate: 'isolate.html', product: 'product.html', admin: 'admin.html' },
    },
  },
});
