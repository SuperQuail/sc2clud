// issue 页前端岛：发布反馈（后续的详情 / 关闭重开也挂在这里）
// 约定见 AGENTS.md §6.6：模板只出结构，交互归岛，网络调用只在 issues-api.ts
import { createApp } from 'vue'
import IssuesIsland from './IssuesIsland.vue'
import type { IssueKind } from './issues-api'

const host = document.querySelector<HTMLElement>('[data-island="issues"]')
if (host) {
  const kind = (host.dataset.kind || 'other') as IssueKind
  createApp(IssuesIsland, {
    postId: Number(host.dataset.postId || 0),
    csrf: host.dataset.csrf || '',
    defaultKind: ['bug', 'feature', 'difficulty', 'other'].includes(kind) ? kind : 'other',
  }).mount(host)
}
