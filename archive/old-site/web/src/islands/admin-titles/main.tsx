// 管理页「头衔管理」岛（控件：ui/TitleAdmin.tsx）
import { createRoot } from 'react-dom/client'
import { TitleAdmin } from '../../ui/TitleAdmin'
import type { AdminTitleRow } from '../../lib/admin'
import '../../ui/ui.css'

function mountAll() {
  document.querySelectorAll<HTMLElement>('[data-island="admin-titles"]').forEach((host) => {
    if (host.dataset.mounted === '1') return
    host.dataset.mounted = '1'
    const data = JSON.parse(host.dataset.json || '{}') as { titles?: AdminTitleRow[] }
    createRoot(host).render(<TitleAdmin csrf={host.dataset.csrf || ''} data={{ titles: data.titles ?? [] }} />)
  })
}

mountAll()
document.addEventListener('sc2clud:remount', mountAll)
