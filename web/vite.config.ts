import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端岛构建：产物直接落进 Web crate 的 static 目录，由 nginx 直出（开发期由 axum 兜底）。
// 预算：单岛 ≤ 120 KB（brotli）—— React+ReactDOM 约 45 KB，Radix 视控件而定。
export default defineConfig({
    // 全站前端岛统一 React 18（见 AGENTS §6.6）
  plugins: [react()],
  build: {
    outDir: '../crates/sc2clud-web/static/islands',
    emptyOutDir: false,
    target: 'es2020',
    cssCodeSplit: false,
    rollupOptions: {
      // 头像岛是纯 TS（不引 Vue），单独入口，互不牵连
      input: { avatar: 'src/avatar.ts', admin: 'src/admin.ts', home: 'src/home.ts', issues: 'src/islands/issues/main.tsx', auth: 'src/auth.ts', 'post-images': 'src/post-images.ts', account: 'src/account.ts', theme: 'src/theme.ts' },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
