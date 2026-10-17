// 管理页「社区开关」岛（控件：ui/AdminCommunity.tsx）
import { createRoot } from 'react-dom/client'
import { AdminCommunity } from '../../ui/AdminCommunity'
import type { AdminCommunityData } from '../../lib/admin'
import '../../ui/ui.css'

function mountAll() {
  document.querySelectorAll<HTMLElement>('[data-island="admin-community"]').forEach((host) => {
    if (host.dataset.mounted === '1') return
    host.dataset.mounted = '1'
    const data = JSON.parse(host.dataset.json || '{}') as AdminCommunityData
    createRoot(host).render(<AdminCommunity csrf={host.dataset.csrf || ''} data={data} />)
  })
}

mountAll()
document.addEventListener('sc2clud:remount', mountAll)
