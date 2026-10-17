// 管理页「分区发言权限」岛（控件：ui/SectionAcl.tsx）
import { createRoot } from 'react-dom/client'
import { SectionAcl } from '../../ui/SectionAcl'
import type { AclData } from '../../lib/admin'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="admin-acl"]').forEach((host) => {
  const data = JSON.parse(host.dataset.json || '{}') as AclData
  createRoot(host).render(<SectionAcl csrf={host.dataset.csrf || ''} data={data} />)
})
