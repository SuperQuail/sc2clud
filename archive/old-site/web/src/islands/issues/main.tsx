// issue 页岛入口：读挂载点上的 data-* 初值，交给 React 组件
import { createRoot } from 'react-dom/client'
import { IssuesApp } from './IssuesApp'
import type { IssueKind } from '../../lib/issues'
import '../../ui/ui.css'

const host = document.querySelector<HTMLElement>('[data-island="issues"]')
if (host) {
  const raw = host.dataset.kind || 'other'
  const kinds: IssueKind[] = ['bug', 'feature', 'difficulty', 'other']
  const defaultKind = kinds.includes(raw as IssueKind) ? (raw as IssueKind) : 'other'
  createRoot(host).render(<IssuesApp
    postId={Number(host.dataset.postId || 0)}
    csrf={host.dataset.csrf || ''}
    defaultKind={defaultKind}
  />)
}
