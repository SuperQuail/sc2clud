// 管理页「待审核」岛（控件：ui/AdminPending.tsx）
import { createRoot } from 'react-dom/client'
import { AdminPending } from '../../ui/AdminPending'
import type { AdminPendingItem } from '../../lib/admin'
import '../../ui/ui.css'

function mountAll() {
  document.querySelectorAll<HTMLElement>('[data-island="admin-pending"]').forEach((host) => {
    if (host.dataset.mounted === '1') return
    host.dataset.mounted = '1'
    const items = JSON.parse(host.dataset.json || '[]') as AdminPendingItem[]
    createRoot(host).render(<AdminPending csrf={host.dataset.csrf || ''} items={items} />)
  })
}

mountAll()
document.addEventListener('sc2clud:remount', mountAll)
