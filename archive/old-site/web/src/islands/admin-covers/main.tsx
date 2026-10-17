// 管理页「分区封面与顺序」岛（控件：ui/SectionCovers.tsx）
import { createRoot } from 'react-dom/client'
import { SectionCovers } from '../../ui/SectionCovers'
import type { CoversData } from '../../lib/admin'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="admin-covers"]').forEach((host) => {
  const data = JSON.parse(host.dataset.json || '{}') as CoversData
  createRoot(host).render(<SectionCovers csrf={host.dataset.csrf || ''} data={data} />)
})
