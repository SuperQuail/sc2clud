// 管理页「发信配置」岛（控件：ui/AdminMail.tsx）
import { createRoot } from 'react-dom/client'
import { AdminMail } from '../../ui/AdminMail'
import type { AdminMailData } from '../../lib/admin'
import '../../ui/ui.css'
import './mail.css'

function mountAll() {
  document.querySelectorAll<HTMLElement>('[data-island="admin-mail"]').forEach((host) => {
    if (host.dataset.mounted === '1') return
    host.dataset.mounted = '1'
    const data = JSON.parse(host.dataset.json || '{}') as AdminMailData
    createRoot(host).render(<AdminMail csrf={host.dataset.csrf || ''} data={data} />)
  })
}

mountAll()
document.addEventListener('sc2clud:remount', mountAll)
