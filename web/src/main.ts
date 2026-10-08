// 前端岛入口：**只挂载被标记的容器**，不做整站接管。
//
// 这样既保留了服务端渲染的首屏体积优势（列表页 HTML ≤ 30 KB），
// 又能在需要交互的地方用上 Vue 的响应式。
import { createApp } from 'vue'

import UploaderIsland from './islands/UploaderIsland.vue'

const host = document.querySelector('[data-island="uploader"]')
if (host) {
  createApp(UploaderIsland).mount(host)
}
