import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 前端岛构建：产物直接落进 Web crate 的 static 目录，由 nginx 直出（开发期由 axum 兜底）。
// 预算：首屏 JS（brotli 后）≤ 60 KB —— Vue 运行时约 15 KB，余量留给岛自身的逻辑。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: '../crates/sc2clud-web/static/islands',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    rollupOptions: {
      // 头像岛是纯 TS（不引 Vue），单独入口，互不牵连
      input: { uploader: 'src/main.ts', avatar: 'src/avatar.ts', admin: 'src/admin.ts', home: 'src/home.ts', auth: 'src/auth.ts', 'post-images': 'src/post-images.ts', account: 'src/account.ts', theme: 'src/theme.ts', 'post-feature': 'src/post-feature.ts' },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
